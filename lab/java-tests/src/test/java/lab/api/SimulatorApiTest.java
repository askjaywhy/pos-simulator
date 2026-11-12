package lab.api;

import io.restassured.response.Response;
import lab.support.Api;
import lab.support.Cards;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.Map;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.*;

/** REST Assured tests for the POS simulator API (authorization, ISO 8583, validation). */
@DisplayName("POS simulator API")
class SimulatorApiTest {

    private static final String MERCHANT = "JAVA-SIM-" + Api.RUN;

    @Test
    @DisplayName("health check reports healthy")
    void health() {
        given().spec(Api.pos())
                .when().get("/health")
                .then().statusCode(200)
                .body("status", equalTo("healthy"))
                .body("timestamp", notNullValue());
    }

    @Test
    @DisplayName("publishes the six test cards")
    void testCards() {
        given().spec(Api.pos())
                .when().get("/test-cards")
                .then().statusCode(200)
                .body("cards", hasSize(6))
                .body("cards.number", hasItems(Cards.VISA, Cards.MASTERCARD, Cards.AMEX, Cards.DISCOVER));
    }

    @ParameterizedTest(name = "{1} card is approved with DE39 00")
    @CsvSource({
            "4111111111111111, VISA",
            "5555555555554444, MASTERCARD",
            "378282246310005,  AMEX",
            "6011111111111117, DISCOVER"
    })
    void approvedPerBrand(String card, String brand) {
        given().spec(Api.pos()).body(Api.payment(card, 25.00, MERCHANT))
                .when().post("/transactions/process")
                .then().log().ifValidationFails()
                .statusCode(200)
                .body(matchesJsonSchemaInClasspath("schemas/process-response.schema.json"))
                .body("success", is(true))
                .body("status", equalTo("APPROVED"))
                .body("response_code", equalTo("00"))
                .body("decline_reason", nullValue())
                .body("auth_code", matchesPattern("^AUTH[0-9A-F]{6}$"))
                .body("card_brand", equalTo(brand))
                .body("card_masked", equalTo(Cards.masked(card)))
                .body("iso8583.mti", equalTo("0100"))
                .body("iso8583.hex_message", startsWith("0100"));
    }

    @ParameterizedTest(name = "card ending {0} is declined with {1} ({2})")
    @CsvSource({
            "4000000000000002, 51, Insufficient Funds",
            "4000000000009987, 41, Lost Card"
    })
    void declines(String card, String code, String reason) {
        given().spec(Api.pos()).body(Api.payment(card, 40.00, MERCHANT))
                .when().post("/transactions/process")
                .then().log().ifValidationFails()
                .statusCode(200)
                .body("success", is(false))
                .body("status", equalTo("DECLINED"))
                .body("response_code", equalTo(code))
                .body("decline_reason", equalTo(reason))
                .body("auth_code", nullValue());
    }

    @Test
    @DisplayName("whole-dollar amount is encoded correctly in DE4")
    void de4WholeDollar() {
        given().spec(Api.pos()).body(Api.payment(Cards.VISA, 10.00, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("iso8583.fields.'4'.value", equalTo("000000001000"));
    }

    @Test
    @DisplayName("stored transaction matches the authorization response")
    void storedTransactionMatches() {
        Response created = Api.pay(Cards.MASTERCARD, 63.17, MERCHANT);
        String id = created.path("transaction_id");

        given().spec(Api.pos())
                .when().get("/transactions/{id}", id)
                .then().statusCode(200)
                .body("id", equalTo(id))
                .body("status", equalTo(created.path("status")))
                .body("response_code", equalTo(created.path("response_code")))
                .body("auth_code", equalTo(created.path("auth_code")))
                .body("card_number_masked", equalTo(Cards.masked(Cards.MASTERCARD)))
                .body("merchant_id", equalTo(MERCHANT))
                .body("amount", equalTo(63.17f))
                .body("iso8583_message.mti", equalTo("0100"));
    }

    @Test
    @DisplayName("unknown transaction id returns 404")
    void unknownTransaction() {
        given().spec(Api.pos())
                .when().get("/transactions/{id}", "00000000-0000-0000-0000-000000000000")
                .then().statusCode(404)
                .body("error", equalTo("Transaction not found"));
    }

    @Test
    @DisplayName("missing required fields returns 400")
    void missingFields() {
        given().spec(Api.pos()).body(Map.of("card_number", Cards.VISA))
                .when().post("/transactions/process")
                .then().statusCode(400)
                .body("error", equalTo("Missing required fields"));
    }

    @Test
    @DisplayName("card number failing Luhn returns 400")
    void luhnFailure() {
        given().spec(Api.pos()).body(Api.payment("4111111111111112", 10.00, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(400)
                .body("error", containsString("Luhn"));
    }

    @Test
    @DisplayName("badly formatted expiry returns 400")
    void expiryFormat() {
        Map<String, Object> body = Api.payment(Cards.VISA, 10.00, MERCHANT);
        body.put("exp_date", "1228");
        given().spec(Api.pos()).body(body)
                .when().post("/transactions/process")
                .then().statusCode(400)
                .body("error", containsString("MM/YY"));
    }

    @Test
    @DisplayName("refund of an approved transaction returns REFUNDED for the full amount")
    void refund() {
        String id = Api.pay(Cards.AMEX, 75.50, MERCHANT).path("transaction_id");
        given().spec(Api.pos())
                .when().post("/transactions/{id}/refund", id)
                .then().statusCode(200)
                .body("status", equalTo("REFUNDED"))
                .body("original_transaction_id", equalTo(id))
                .body("amount", equalTo(75.5f))
                .body("refund_id", notNullValue());
    }

    /** Hex of a string's ASCII bytes: how hex_message encodes each field value. */
    private static String asciiHex(String s) {
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) sb.append(String.format("%02X", (int) c));
        return sb.toString();
    }

    @Test
    @DisplayName("PAN is truncated in DE2, hex_message and storage (DEF-003, PCI DSS)")
    void panIsMasked() {
        String masked = "411111******1111";
        Response r = Api.pay(Cards.VISA, 12.00, MERCHANT);
        String id = r.path("transaction_id");

        r.then()
                .body("iso8583.fields.'2'.value", equalTo(masked))
                .body("iso8583.hex_message", not(containsString(asciiHex(Cards.VISA))))
                .body("iso8583.hex_message", containsString(asciiHex(masked)));

        String stored = given().spec(Api.pos())
                .when().get("/transactions/{id}", id)
                .then().statusCode(200)
                .body("iso8583_message.fields.'2'.value", equalTo(masked))
                .extract().asString();
        org.junit.jupiter.api.Assertions.assertFalse(stored.contains(Cards.VISA), "stored row contains the full PAN");
        org.junit.jupiter.api.Assertions.assertFalse(stored.contains(asciiHex(Cards.VISA)), "stored hex_message contains the full PAN");
    }

    @ParameterizedTest(name = "DE39 and tag 8A carry response code {1} (DEF-002)")
    @CsvSource({
            "4111111111111111, 00, 3030",   // approved
            "4000000000000002, 51, 3531",   // insufficient funds
            "4000000000009987, 41, 3431",   // lost card
            "5105105105105100, 05, 3035"    // generic decline (test PAN)
    })
    void de39MatchesDecision(String card, String code, String tag8a) {
        String id = given().spec(Api.pos()).body(Api.payment(card, 20.00, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("response_code", equalTo(code))
                .body("iso8583.fields.'39'.value", equalTo(code))
                .body("emv.tags.'8A'.value", equalTo(tag8a))
                .body("emv.tlv_hex", containsString("8A02" + tag8a))
                .extract().path("transaction_id");

        given().spec(Api.pos())
                .when().get("/transactions/{id}", id)
                .then().statusCode(200)
                .body("iso8583_message.fields.'39'.value", equalTo(code));
    }

    @ParameterizedTest(name = "DE4 encodes {0} as {1} (DEF-001)")
    @CsvSource({
            "19.99,   000000001999",
            "0.29,    000000000029",
            "4.35,    000000000435",
            "1.15,    000000000115",
            "0.01,    000000000001",
            "1234.56, 000000123456"
    })
    void de4AmountPrecision(double amount, String expected) {
        String id = given().spec(Api.pos()).body(Api.payment(Cards.VISA, amount, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("iso8583.fields.'4'.value", equalTo(expected))
                .extract().path("transaction_id");

        given().spec(Api.pos())
                .when().get("/transactions/{id}", id)
                .then().statusCode(200)
                .body("iso8583_message.fields.'4'.value", equalTo(expected));
    }

    @ParameterizedTest(name = "primary bitmap marks exactly the fields present for {0} (DEF-008)")
    @CsvSource({"4111111111111111", "4000000000000002"})
    void bitmapMatchesFields(String card) {
        Response r = Api.pay(card, 10.00, MERCHANT);
        String hex = r.path("iso8583.hex_message");

        // The 0100 carries DE2, 4, 11, 12, 13, 39, 49 and 55: bits 2, 4, 11, 12, 13, 39, 49, 55
        // of a 64-bit primary bitmap (bit 1 = most significant).
        org.junit.jupiter.api.Assertions.assertEquals("5038000002008200", hex.substring(4, 20));

        // Property check: decode the bitmap and compare it with the fields actually returned.
        long bitmap = Long.parseUnsignedLong(hex.substring(4, 20), 16);
        java.util.Set<Integer> fromBitmap = new java.util.TreeSet<>();
        for (int bit = 1; bit <= 64; bit++) {
            if ((bitmap & (1L << (64 - bit))) != 0) fromBitmap.add(bit);
        }
        Map<String, Map<String, Object>> fields = r.path("iso8583.fields");
        java.util.Set<Integer> present = new java.util.TreeSet<>();
        fields.forEach((num, f) -> {
            Object v = f.get("value");
            if (v != null && !String.valueOf(v).isEmpty()) present.add(Integer.parseInt(num));
        });
        org.junit.jupiter.api.Assertions.assertEquals(present, fromBitmap);
    }

    @ParameterizedTest(name = "amount {0} is rejected with 400 (DEF-006)")
    @ValueSource(doubles = {-5.00, -0.01, 0.001, 19.999, 1e13})
    void invalidAmountRejected(double amount) {
        given().spec(Api.pos()).body(Api.payment(Cards.VISA, amount, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(400)
                .body("error", startsWith("Invalid amount"));
    }

    @Test
    @DisplayName("non-numeric amount is rejected with 400 (DEF-006)")
    void nonNumericAmountRejected() {
        given().spec(Api.pos()).body(Api.payment(Cards.VISA, "abc", MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(400)
                .body("error", startsWith("Invalid amount"));
    }

    @ParameterizedTest(name = "boundary amount {0} is accepted (DEF-006)")
    @CsvSource({"0.01, 000000000001", "9999999999.99, 999999999999"})
    void boundaryAmountAccepted(double amount, String de4) {
        given().spec(Api.pos()).body(Api.payment(Cards.VISA, amount, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("iso8583.fields.'4'.value", equalTo(de4));
    }

    @ParameterizedTest(name = "expiry {0} is rejected with 400 (DEF-004)")
    @ValueSource(strings = {"00/28", "13/28", "99/28"})
    void invalidExpiryMonthRejected(String exp) {
        Map<String, Object> body = Api.payment(Cards.VISA, 10.00, MERCHANT);
        body.put("exp_date", exp);
        given().spec(Api.pos()).body(body)
                .when().post("/transactions/process")
                .then().statusCode(400)
                .body("error", equalTo("Invalid expiration month (01-12)"));
    }

    @ParameterizedTest(name = "expiry {0} is accepted (DEF-004)")
    @ValueSource(strings = {"01/28", "12/28"})
    void validExpiryMonthAccepted(String exp) {
        Map<String, Object> body = Api.payment(Cards.VISA, 10.00, MERCHANT);
        body.put("exp_date", exp);
        given().spec(Api.pos()).body(body)
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("status", equalTo("APPROVED"));
    }

    /** MM/YY for a month relative to now, in UTC like the simulator (assumes SIM_NOW is not set). */
    private static String expiry(int monthsFromNow) {
        java.time.YearMonth ym = java.time.YearMonth.now(java.time.ZoneOffset.UTC).plusMonths(monthsFromNow);
        return String.format("%02d/%02d", ym.getMonthValue(), ym.getYear() % 100);
    }

    private Response payWithExpiry(String card, String exp) {
        Map<String, Object> body = Api.payment(card, 10.00, MERCHANT);
        body.put("exp_date", exp);
        return given().spec(Api.pos()).body(body).when().post("/transactions/process");
    }

    @Test
    @DisplayName("expired card (01/20) is declined 54 in the API, DE39 and tag 8A (DEF-005)")
    void expiredCardDeclined() {
        payWithExpiry(Cards.VISA, "01/20").then().statusCode(200)
                .body("status", equalTo("DECLINED"))
                .body("response_code", equalTo("54"))
                .body("decline_reason", equalTo("Expired Card"))
                .body("auth_code", nullValue())
                .body("iso8583.fields.'39'.value", equalTo("54"))
                .body("emv.tags.'8A'.value", equalTo("3534"));
    }

    @Test
    @DisplayName("card that expired last month is declined 54 (DEF-005)")
    void expiredLastMonthDeclined() {
        payWithExpiry(Cards.VISA, expiry(-1)).then().statusCode(200)
                .body("response_code", equalTo("54"));
    }

    @Test
    @DisplayName("card expiring this month is still approved (DEF-005)")
    void expiringThisMonthApproved() {
        payWithExpiry(Cards.VISA, expiry(0)).then().statusCode(200)
                .body("status", equalTo("APPROVED"))
                .body("response_code", equalTo("00"));
    }

    @Test
    @DisplayName("a decline rule takes precedence over expiry: •••• 0002 with 01/20 is 51 (DEF-005)")
    void declineRuleBeatsExpiry() {
        payWithExpiry(Cards.VISA_INSUFFICIENT_FUNDS, "01/20").then().statusCode(200)
                .body("response_code", equalTo("51"));
    }
}
