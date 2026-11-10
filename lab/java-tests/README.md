# Java tests: REST Assured, Cucumber, Selenium

Java 17 / Maven test suite for the POS lab. It runs in Docker, so you don't need to install Java or Maven.

| Layer | Tool | Tests |
|---|---|---|
| API | REST Assured + JSON Schema | `SimulatorApiTest` (authorization, ISO 8583, validation, refunds), `RiskApiTest` (rules contract, reason codes, card blocks, dispute validation) |
| BDD | Cucumber (Gherkin) + REST Assured | `features/chargeback.feature`: network reason codes, arbitration, merchant accepts, out-of-order and missing-evidence cases |
| UI | Selenium 4 + Page Object Model | `RiskConsoleUiTest`: navigation, block/release a card, chargeback form and representment, alert review, rule validation |
| Defects | REST Assured | `KnownDefectsTest`: 7 simulator defects, excluded by default (see `DEFECTS.md`) |

## Run (from the `lab` folder, with the lab running)
```powershell
docker compose run --rm java-tests                                   # full suite (API + BDD + UI)
docker compose run --rm java-tests mvn -B -ntp test -Dtest=SimulatorApiTest
docker compose run --rm java-tests mvn -B -ntp test -Dtest=RiskConsoleUiTest
docker compose run --rm java-tests mvn -B -ntp test -Dtest=RunCucumberTest
docker compose run --rm java-tests mvn -B -ntp test -Dgroups=known-defect -DexcludedGroups=   # expected to FAIL
```
The first run downloads Maven dependencies (a few minutes). Later runs use the `m2-cache` volume.

**Watch Selenium drive the browser:** open http://localhost:7900 while the UI tests run. No password is needed.

## Reports (in `java-tests/target/`)
- `surefire-reports/`: JUnit XML and text results per test class
- `cucumber-report.html`: open in a browser for the BDD scenarios
- `screenshots/`: a PNG for every UI test that failed

## Design notes
- **Config by environment:** `POS_API`, `RISK_API`, `CONSOLE_URL`, `SELENIUM_URL` (see `Config.java`). Without `SELENIUM_URL`, tests launch a local headless Chrome, so the suite also runs straight from IntelliJ or `mvn test` on Windows.
- **No fixed sleeps for pipeline work:** `Api.waitUntil` polls until Kafka → Postgres has loaded the record.
- **UI tests check the system of record:** each UI action is verified through the API too, not just by what the page shows.
- **Known defects stay visible but don't break the build:** tagged `known-defect` and excluded by default through `excludedGroups` in `pom.xml`.
