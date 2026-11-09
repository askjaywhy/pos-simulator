# POS Simulator Lab — Kafka, Postgres, Splunk

A Docker lab around the POS simulator for practicing event-driven testing, backend
data validation, and Splunk monitoring. The simulator itself is not changed.

```
POS simulator (:3001)                      [runs on Windows as usual]
   │  GET /api/transactions/history every 2s
   ▼
tx-producer ──► Kafka topic pos.transactions (3 partitions, key = masked card)
                   │
                   ├─► consumer group postgres-sink ─► Postgres  card_transactions
                   └─► consumer group splunk-sink   ─► Splunk    sourcetype pos:transaction
```

## Requirements
- Docker Desktop running (WSL 2 backend), about 6 GB RAM free. Splunk uses the most memory.
- POS simulator started with `START_POS_SIMULATOR.bat`.

## Start
```powershell
cd C:\Users\Askja\pos-simulator\lab
.\Start-Lab.ps1
```
If scripts are blocked: `powershell -ExecutionPolicy Bypass -File .\Start-Lab.ps1`.

| What | Where | Login |
|---|---|---|
| Splunk dashboard | http://localhost:8000/en-US/app/pos_lab/pos_overview | admin / PosLab#2026 |
| Kafka UI | http://localhost:8080 | none |
| Risk console (fraud & disputes) | http://localhost:3002 | none |
| Postgres | localhost:5432, database `poslab` | poslab / poslab |

## Everyday commands (from the `lab` folder)
```powershell
docker compose run --rm traffic                    # 100 mixed transactions at 2 TPS (approvals + 51/41 declines)
docker compose run --rm -e COUNT=500 -e TPS=10 traffic
docker compose run --rm verify                     # source-to-target check: simulator vs Postgres vs Splunk
docker compose logs -f tx-producer tx-sinks        # watch messages flow
docker exec -it pos-postgres psql -U poslab -d poslab
.\Stop-Lab.ps1            # stop (keeps data)
.\Stop-Lab.ps1 -Wipe      # stop and delete Postgres/Splunk data
```

## Exercises

**Kafka (event-driven testing)**
1. In Kafka UI, open `pos.transactions`. Messages are keyed by masked card. Confirm that every event for a given card sits on the same partition.
2. Stop the Splunk sink path: `docker stop pos-splunk`. Send traffic, then start Splunk again. Confirm the backlog drains and nothing is lost (consumer group `splunk-sink` lag goes back to 0).
3. Restart `tx-sinks` while traffic is running. Use query 5 in `sql/practice-queries.sql` to check for gaps or duplicates. The Postgres upsert makes redelivery safe. Explain why.
4. Find each consumer group's lag in Kafka UI, then write down what "at-least-once delivery" means for this pipeline.

**SQL / backend data validation**
5. Run `sql/practice-queries.sql`. Queries 3 and 4 should return 0 rows. Each one is a data-quality rule.
6. Pick a transaction in the simulator UI. Find it by `id` in Postgres and in Splunk, then compare every field. This is what `verify.js` automates.

**Splunk**
7. The dashboard is a starting point. Add panels for average ticket by merchant, declines in the last 5 minutes, and transactions over $500.
8. Build an alert that fires when the approval rate drops below 85% in a 5-minute window. Test it with heavy decline traffic.
9. Search the pipeline itself: `index=* sourcetype="pos:transaction" | stats count by kafka_partition`.

## Fraud & chargeback module (risk-service)

`risk-service` is a fraud engine plus a back-office API and console on **http://localhost:3002**. It reads the same Kafka topic as the other consumers (consumer group `fraud-engine`) and stores everything in Postgres.

```
pos.transactions ──► fraud-engine ──► fraud_alerts, card_blocks ──► pos.fraud.alerts ──► Splunk (pos:fraud)
                                            │ analyst confirms fraud
                                            ▼
           Risk API / console ──► disputes, dispute_events ──► pos.disputes ──► Splunk (pos:dispute)
```

**Fraud rules.** These are editable in the console's Rules tab or with `PUT /api/fraud/rules/:id`.

| Rule | Fires when | Severity |
|---|---|---|
| VELOCITY | 10+ transactions on one card at one merchant within 30s (one alert per 5 min) | high |
| HIGH_AMOUNT | amount ≥ $2,000 | medium |
| LOST_STOLEN | DE39 = 41 or 43. **The card is blocked automatically.** | high |
| BLOCKED_CARD_ACTIVITY | an APPROVED authorization on a card with an active block | critical |

The simulator doesn't check fraud blocks, so BLOCKED_CARD_ACTIVITY catches approvals that a real issuer should have declined.

**Chargeback lifecycle**
`CHARGEBACK_FILED → REPRESENTED → PRE_ARBITRATION → ARBITRATION → CLOSED_*`. Other exits are merchant accepts, issuer accepts the representment, or issuer withdraws. The cardholder gets provisional credit when the chargeback is filed. If the merchant wins, that credit is reversed.

The validation rules are:
- Only APPROVED transactions can be disputed.
- The reason code must belong to the card's network (Visa 10.4/12.6.1/13.x, Mastercard 4837/4834/4853, Amex F29/P08/C08, Discover UA02/DP/RG).
- The disputed amount can't exceed the transaction.
- A transaction can have only one open dispute.
- Disputes must be filed within 120 days.
- Representment and pre-arbitration require a note.

Confirming fraud on an approved transaction automatically files a fraud chargeback.

**Run it**
```powershell
docker compose up -d --build                         # starts risk-service with everything else
docker restart pos-splunk                            # first time only: loads the new Splunk dashboard
docker compose run --rm --build fraud-scenarios      # 8 scenarios, ~40 checks, PASS/FAIL table
docker compose run --rm traffic                      # normal traffic (2 TPS)
docker compose run --rm -e TPS=8 traffic             # bot-like traffic: watch VELOCITY fire
```
- Console: http://localhost:3002
- Splunk: **POS Lab → Fraud & Disputes**
- SQL: `sql/fraud-queries.sql`
- Unit tests: `cd risk; node --test tests/unit.test.js` (no install needed)

### Fraud exercises
1. Run `fraud-scenarios`, then find every scenario's alerts and disputes in the console and in Splunk.
2. **Rule tuning:** run traffic at TPS=8 and count VELOCITY alerts. Raise `max_txns` to 20 and run again. Mark a few alerts as false positives and watch the precision column in Splunk. That's the trade-off between catching fraud and annoying cardholders.
3. **Control test:** block card 1111 in the console, then send traffic. Every approved 1111 transaction should raise a critical alert. Prove there are no gaps with queries 3 and 4 in `fraud-queries.sql`. Release the block afterwards.
4. **Chargeback walk-through:** take an approved transaction ID from Postgres. File a chargeback in the console with the right network's reason code, then try the wrong network's code first (422). Drive it to arbitration and check the audit trail (query 7).
5. **Negative testing:** use Postman against `http://localhost:3002/api` to find a request that should be rejected but isn't. Write it up as a defect: steps, expected, actual.
6. **Resilience:** run `docker kill pos-risk-service` mid-traffic, start it again, and confirm no transaction was scored twice and none was skipped (query 2, plus `fraud-engine` lag in Kafka UI).

### Risk API reference
| Method & path | Purpose |
|---|---|
| `GET /api/summary` | header counts |
| `GET /api/fraud/rules`, `PUT /api/fraud/rules/:id` | view / tune rules (`{enabled, severity, params}`) |
| `GET /api/fraud/alerts?status=&rule_id=&card=` | list alerts |
| `POST /api/fraud/alerts/:id/review` | `{decision: CONFIRMED_FRAUD or FALSE_POSITIVE, analyst, note}` |
| `GET /api/cards/blocks?active=true`, `POST /api/cards/blocks`, `POST /api/cards/blocks/:id/release` | card blocks (`{card: "1117", reason}`) |
| `GET /api/disputes/reason-codes?network=VISA` | reason codes |
| `GET /api/disputes?open=true`, `GET /api/disputes/:id` | disputes and audit trail |
| `POST /api/disputes` | `{transaction_id, reason_code, amount?, note?}` |
| `POST /api/disputes/:id/actions` | `{action, note}`; the response lists `allowed_actions` |

## Coming next
- **AWS migration:** treat this Postgres as on-prem and migrate it to LocalStack. Reconcile source against target.
- **REST Assured / SOAP:** Java API tests and a SOAP card-servicing endpoint.

## Troubleshooting
- **Producer logs "POS simulator not reachable":** the simulator isn't running on :3001, or Docker can't reach the host. Check `http://localhost:3001/api/health` in a browser.
- **Splunk unhealthy or very slow:** give Docker Desktop more memory (Settings → Resources). The first boot takes 2–4 minutes.
- **The simulator keeps data only in memory.** Restarting it clears its history. Postgres and Splunk keep what they already received.
- **Port already in use:** something else is on 8000, 8080, 8088, 8089, 5432 or 9094. Stop it, or change the left-hand port in `docker-compose.yml`.
