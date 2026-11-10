package lab.support;

import io.restassured.builder.RequestSpecBuilder;
import io.restassured.filter.log.LogDetail;
import io.restassured.http.ContentType;
import io.restassured.response.Response;
import io.restassured.specification.RequestSpecification;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import static io.restassured.RestAssured.given;

/** Shared REST Assured specs and helpers for the simulator and risk APIs. */
public final class Api {
    private Api() {}

    /** Unique suffix so each run's merchants/records are easy to find. */
    public static final String RUN = UUID.randomUUID().toString().substring(0, 5).toUpperCase();

    public static RequestSpecification pos() {
        return new RequestSpecBuilder()
                .setBaseUri(Config.POS_API)
                .setContentType(ContentType.JSON)
                .log(LogDetail.METHOD)
                .log(LogDetail.URI)
                .build();
    }

    public static RequestSpecification risk() {
        return new RequestSpecBuilder()
                .setBaseUri(Config.RISK_API)
                .setContentType(ContentType.JSON)
                .log(LogDetail.METHOD)
                .log(LogDetail.URI)
                .build();
    }

    /** Build a simulator payment request body. */
    public static Map<String, Object> payment(String card, Object amount, String merchant) {
        Map<String, Object> body = new HashMap<>();
        body.put("card_number", card);
        body.put("exp_date", "12/28");
        body.put("cvv", "123");
        body.put("amount", amount);
        body.put("merchant_id", merchant);
        body.put("description", "java-tests " + RUN);
        return body;
    }

    /** Send a payment that is expected to be processed (HTTP 200, approved or declined). */
    public static Response pay(String card, double amount, String merchant) {
        return given().spec(pos()).body(payment(card, amount, merchant))
                .when().post("/transactions/process")
                .then().log().ifValidationFails().statusCode(200)
                .extract().response();
    }

    /**
     * Wait until postgres-sink has loaded a transaction. Probes POST /disputes with an
     * invalid reason code: 404 = not loaded yet, 422 = loaded (rejected, nothing created).
     */
    public static void waitLoaded(String transactionId) {
        waitUntil("transaction " + transactionId + " loaded into Postgres", () ->
                given().spec(risk())
                        .body(Map.of("transaction_id", transactionId, "reason_code", "PROBE"))
                        .post("/disputes").statusCode() == 422);
    }

    /** Poll a condition until it's true or the pipeline timeout passes. */
    public static void waitUntil(String what, Supplier<Boolean> condition) {
        long deadline = System.nanoTime() + Duration.ofSeconds(Config.PIPELINE_TIMEOUT_SECONDS).toNanos();
        while (System.nanoTime() < deadline) {
            try {
                if (Boolean.TRUE.equals(condition.get())) return;
            } catch (RuntimeException ignored) {
                // service still starting or record not there yet
            }
            sleep(1500);
        }
        throw new AssertionError("Timed out after " + Config.PIPELINE_TIMEOUT_SECONDS + "s waiting for: " + what);
    }

    public static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
