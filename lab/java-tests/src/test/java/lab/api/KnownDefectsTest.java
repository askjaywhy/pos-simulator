package lab.api;

import io.restassured.response.Response;
import lab.support.Api;
import lab.support.Cards;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

/**
 * Defects found in the POS simulator. Each test states the CORRECT behavior, so it
 * FAILS until the defect is fixed. Excluded from the default run; see DEFECTS.md.
 *
 *   mvn test -Dgroups=known-defect -DexcludedGroups=
 */
@Tag("known-defect")
@DisplayName("Known defects (fail until fixed)")
class KnownDefectsTest {

    private static final String MERCHANT = "JAVA-DEFECT-" + Api.RUN;

    @ParameterizedTest(name = "DEF-001 DE4 encodes ${0} exactly")
    @ValueSource(doubles = {19.99, 0.29, 4.35, 1.15})
    void de4AmountPrecision(double amount) {
        String expected = String.format("%012d", Math.round(amount * 100));
        given().spec(Api.pos()).body(Api.payment(Cards.VISA, amount, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("iso8583.fields.'4'.value", equalTo(expected));
    }

    @Test
    @DisplayName("DEF-002 DE39 carries the decline code, not 00")
    void de39MatchesDecline() {
        given().spec(Api.pos()).body(Api.payment(Cards.VISA_INSUFFICIENT_FUNDS, 20.00, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("response_code", equalTo("51"))
                .body("iso8583.fields.'39'.value", equalTo("51"));
    }

    @Test
    @DisplayName("DEF-003 full PAN is never returned or stored (PCI DSS)")
    void panIsMasked() {
        Response r = Api.pay(Cards.VISA, 12.00, MERCHANT);
        String id = r.path("transaction_id");

        r.then()
                .body("iso8583.fields.'2'.value", not(equalTo(Cards.VISA)))
                .body("iso8583.hex_message", not(containsString(Cards.VISA)));

        given().spec(Api.pos())
                .when().get("/transactions/{id}", id)
                .then().statusCode(200)
                .body("iso8583_message.fields.'2'.value", not(equalTo(Cards.VISA)))
                .body("iso8583_message.hex_message", not(containsString(Cards.VISA)));
    }

    @Test
    @DisplayName("DEF-004 invalid expiry month (13) is rejected")
    void invalidExpiryMonth() {
        Map<String, Object> body = Api.payment(Cards.VISA, 10.00, MERCHANT);
        body.put("exp_date", "13/30");
        given().spec(Api.pos()).body(body)
                .when().post("/transactions/process")
                .then().statusCode(400);
    }

    @Test
    @DisplayName("DEF-005 expired card is declined with 54")
    void expiredCardDeclined() {
        Map<String, Object> body = Api.payment(Cards.VISA, 10.00, MERCHANT);
        body.put("exp_date", "01/20");
        given().spec(Api.pos()).body(body)
                .when().post("/transactions/process")
                .then().statusCode(200)
                .body("status", equalTo("DECLINED"))
                .body("response_code", equalTo("54"));
    }

    @Test
    @DisplayName("DEF-006 negative amount is rejected")
    void negativeAmountRejected() {
        given().spec(Api.pos()).body(Api.payment(Cards.VISA, -5.00, MERCHANT))
                .when().post("/transactions/process")
                .then().statusCode(400);
    }

    @Test
    @DisplayName("DEF-007 declined transaction cannot be refunded")
    void refundOfDeclinedRejected() {
        String id = Api.pay(Cards.VISA_LOST, 30.00, MERCHANT).path("transaction_id");
        int status = given().spec(Api.pos())
                .when().post("/transactions/{id}/refund", id)
                .then().extract().statusCode();
        org.hamcrest.MatcherAssert.assertThat("refund of a DECLINED transaction should be rejected (409/422)",
                status, anyOf(equalTo(409), equalTo(422)));
    }
}
