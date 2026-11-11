package lab.api;

import io.restassured.response.Response;
import lab.support.Api;
import lab.support.Cards;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

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
}
