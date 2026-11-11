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
