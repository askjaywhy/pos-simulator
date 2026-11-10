package lab.api;

import lab.support.Api;
import lab.support.Cards;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.*;

/** REST Assured tests for the risk service: rules, reason codes, card blocks, dispute validation. */
@DisplayName("Risk service API")
class RiskApiTest {

    private static final String MERCHANT = "JAVA-RISK-" + Api.RUN;
    private static String approvedVisaTxn;
    private static String declinedTxn;

    @BeforeAll
    static void createTransactions() {
        approvedVisaTxn = Api.pay(Cards.VISA, 80.00, MERCHANT).path("transaction_id");
        declinedTxn = Api.pay(Cards.VISA_INSUFFICIENT_FUNDS, 15.00, MERCHANT).path("transaction_id");
        Api.waitLoaded(approvedVisaTxn);
        Api.waitLoaded(declinedTxn);
    }

    @Test
    @DisplayName("health check reports healthy")
    void health() {
        given().spec(Api.risk()).when().get("/health")
                .then().statusCode(200).body("status", equalTo("healthy"));
    }

    @Test
    @DisplayName("fraud rules match the published contract (JSON schema)")
    void rulesContract() {
        given().spec(Api.risk()).when().get("/fraud/rules")
                .then().statusCode(200)
                .body(matchesJsonSchemaInClasspath("schemas/fraud-rules.schema.json"))
                .body("rules.rule_id", hasItems("VELOCITY", "HIGH_AMOUNT", "LOST_STOLEN", "BLOCKED_CARD_ACTIVITY"))
                .body("rules.find { it.rule_id == 'BLOCKED_CARD_ACTIVITY' }.severity", equalTo("critical"));
    }

    @ParameterizedTest(name = "{0} has fraud code {1} and consumer code {2}")
    @CsvSource({
            "VISA,       10.4, 13.1",
            "MASTERCARD, 4837, 4853",
            "AMEX,       F29,  C08",
            "DISCOVER,   UA02, RG"
    })
    void reasonCodesPerNetwork(String network, String fraudCode, String consumerCode) {
        given().spec(Api.risk()).queryParam("network", network)
                .when().get("/disputes/reason-codes")
                .then().statusCode(200)
                .body("reason_codes.network", everyItem(equalTo(network)))
                .body("reason_codes.find { it.code == '" + fraudCode + "' }.category", equalTo("fraud"))
                .body("reason_codes.find { it.code == '" + consumerCode + "' }.category", equalTo("consumer"));
    }

    @ParameterizedTest(name = "rule update rejected: {0}")
    @CsvSource(delimiter = '|', value = {
            "VELOCITY    | {\"params\": {\"max_txns\": 0}}          | positive integer",
            "VELOCITY    | {\"severity\": \"urgent\"}                 | severity",
            "HIGH_AMOUNT | {\"params\": {\"min_amount\": -1}}         | greater than 0",
            "LOST_STOLEN | {\"params\": {\"response_codes\": [\"4\"]}} | 2-digit",
            "VELOCITY    | {\"enabled\": \"yes\"}                     | true or false"
    })
    void invalidRuleUpdates(String rule, String body, String message) {
        given().spec(Api.risk()).body(body)
                .when().put("/fraud/rules/{id}", rule)
                .then().statusCode(422)
                .body("error", containsString(message));
    }

    @Test
    @DisplayName("unknown rule returns 404")
    void unknownRule() {
        given().spec(Api.risk()).body(Map.of("enabled", true))
                .when().put("/fraud/rules/{id}", "NOPE")
                .then().statusCode(404);
    }

    @Test
    @DisplayName("card block: create, duplicate rejected, release, double release rejected")
    void cardBlockLifecycle() {
        String card = "1117";
        releaseActiveBlock(card); // clean precondition

        // BIGSERIAL ids come back as JSON strings from node-postgres
        String blockId = given().spec(Api.risk()).body(Map.of("card", card, "reason", "java-tests " + Api.RUN))
                .when().post("/cards/blocks")
                .then().statusCode(201)
                .body("card_masked", equalTo(Cards.masked(Cards.DISCOVER)))
                .body("active", is(true))
                .extract().path("block_id");

        given().spec(Api.risk()).body(Map.of("card", "•••• 1117", "reason", "again"))
                .when().post("/cards/blocks")
                .then().statusCode(409).body("error", containsString("already has an active block"));

        given().spec(Api.risk()).body(Map.of("analyst", "java-tests"))
                .when().post("/cards/blocks/{id}/release", blockId)
                .then().statusCode(200).body("active", is(false)).body("released_by", equalTo("java-tests"));

        given().spec(Api.risk()).body(Map.of())
                .when().post("/cards/blocks/{id}/release", blockId)
                .then().statusCode(409);
    }

    @Test
    @DisplayName("card block requires card and reason")
    void cardBlockValidation() {
        given().spec(Api.risk()).body(Map.of("reason", "x")).when().post("/cards/blocks")
                .then().statusCode(422).body("error", containsString("card is required"));
        given().spec(Api.risk()).body(Map.of("card", "1111")).when().post("/cards/blocks")
                .then().statusCode(422).body("error", containsString("reason is required"));
    }

    @Test
    @DisplayName("dispute on an approved transaction is created with the right shape")
    void disputeCreated() {
        String txn = Api.pay(Cards.VISA, 44.00, MERCHANT).path("transaction_id");
        Api.waitLoaded(txn);
        given().spec(Api.risk())
                .body(Map.of("transaction_id", txn, "reason_code", "13.3", "amount", 20.5, "note", "item damaged"))
                .when().post("/disputes")
                .then().statusCode(201)
                .body(matchesJsonSchemaInClasspath("schemas/dispute.schema.json"))
                .body("state", equalTo("CHARGEBACK_FILED"))
                .body("network", equalTo("VISA"))
                .body("dispute_amount", equalTo("20.50"))
                .body("txn_amount", equalTo("44.00"))
                .body("provisional_credit", is(true))
                .body("allowed_actions", containsInAnyOrder("merchant_accept", "represent", "withdraw"));
    }

    @ParameterizedTest(name = "rejected with {2}: {0}")
    @CsvSource(delimiter = '|', value = {
            "declined transaction              | DECLINED | 422",
            "Mastercard code on Visa           | WRONG    | 422",
            "amount above transaction          | OVER     | 422",
            "zero amount                       | ZERO     | 422",
            "unknown transaction               | UNKNOWN  | 404",
            "missing transaction id            | MISSING  | 422"
    })
    void disputeValidation(String label, String kase, int expected) {
        Map<String, Object> body = switch (kase) {
            case "DECLINED" -> Map.of("transaction_id", declinedTxn, "reason_code", "13.1");
            case "WRONG" -> Map.of("transaction_id", approvedVisaTxn, "reason_code", "4853");
            case "OVER" -> Map.of("transaction_id", approvedVisaTxn, "reason_code", "13.1", "amount", 80.01);
            case "ZERO" -> Map.of("transaction_id", approvedVisaTxn, "reason_code", "13.1", "amount", 0);
            case "UNKNOWN" -> Map.of("transaction_id", "does-not-exist", "reason_code", "13.1");
            default -> Map.of("reason_code", "13.1");
        };
        given().spec(Api.risk()).body(body)
                .when().post("/disputes")
                .then().log().ifValidationFails().statusCode(expected)
                .body("error", not(emptyOrNullString()));
    }

    @Test
    @DisplayName("only one open dispute per transaction")
    void duplicateOpenDispute() {
        String txn = Api.pay(Cards.MASTERCARD, 55.00, MERCHANT).path("transaction_id");
        Api.waitLoaded(txn);
        given().spec(Api.risk()).body(Map.of("transaction_id", txn, "reason_code", "4853"))
                .post("/disputes").then().statusCode(201);
        given().spec(Api.risk()).body(Map.of("transaction_id", txn, "reason_code", "4834"))
                .post("/disputes").then().statusCode(409).body("error", containsString("already has an open dispute"));
    }

    /** Release any active block on the card so the test starts clean. */
    private static void releaseActiveBlock(String last4) {
        List<Map<String, Object>> blocks = given().spec(Api.risk()).queryParam("active", "true")
                .get("/cards/blocks").then().statusCode(200).extract().path("blocks");
        for (Map<String, Object> b : blocks) {
            if (String.valueOf(b.get("card_masked")).endsWith(last4)) {
                given().spec(Api.risk()).body(Map.of("analyst", "java-tests"))
                        .post("/cards/blocks/{id}/release", b.get("block_id"));
            }
        }
    }
}
