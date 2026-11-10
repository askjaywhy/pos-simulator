package lab.ui;

import lab.support.Api;
import lab.support.Cards;
import lab.ui.pages.RiskConsolePage;
import lab.ui.pages.RiskConsolePage.Toast;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.*;

/**
 * Selenium tests for the Risk Console. Each test sets up data through the API,
 * acts through the browser, then verifies through the API as well, so the UI
 * is checked against the system of record rather than against itself.
 */
@DisplayName("Risk Console UI")
class RiskConsoleUiTest extends BaseUiTest {

    private static final String MERCHANT = "JAVA-UI-" + Api.RUN;

    @Test
    @DisplayName("loads with summary KPIs and four working tabs")
    void loadsAndNavigates() {
        RiskConsolePage page = new RiskConsolePage(driver).open();

        assertThat(page.kpi("kpi-open-alerts"), matchesPattern("\\d+"));
        assertThat(page.kpi("kpi-dispute-amount"), startsWith("$"));
        assertThat(page.isTabSelected("alerts"), is(true));

        page.openTab("rules");
        assertThat(page.isTabSelected("rules"), is(true));
        assertThat(page.rowCount("rules-table", "rule-row"), equalTo(4));

        page.openTab("disputes");
        assertThat(page.isTabSelected("disputes"), is(true));
        assertThat(page.isTabSelected("rules"), is(false));
    }

    @Test
    @DisplayName("analyst blocks and releases a card; API agrees at each step")
    void blockAndReleaseCard() {
        releaseActiveBlock("1117");
        RiskConsolePage page = new RiskConsolePage(driver).open();

        Toast blocked = page.blockCard("1117", "UI test " + Api.RUN);
        assertThat(blocked.error(), is(false));
        assertThat(blocked.text(), containsString("•••• 1117 blocked"));
        assertThat(activeBlockExists("1117"), is(true));

        Toast duplicate = page.blockCard("1117", "duplicate");
        assertThat("second block on same card must be rejected", duplicate.error(), is(true));
        assertThat(duplicate.text(), containsString("already has an active block"));

        Toast released = page.releaseBlockForCard("1117");
        assertThat(released.text(), containsString("released"));
        assertThat(activeBlockExists("1117"), is(false));
    }

    @Test
    @DisplayName("chargeback form enforces network reason codes, then files and represents")
    void fileAndRepresentChargeback() {
        String txn = Api.pay(Cards.VISA, 64.00, MERCHANT).path("transaction_id");
        Api.waitLoaded(txn);
        RiskConsolePage page = new RiskConsolePage(driver).open();

        Toast wrongNetwork = page.fileChargeback(txn, "MASTERCARD", "4853", null);
        assertThat(wrongNetwork.error(), is(true));
        assertThat(wrongNetwork.text(), containsString("not valid for VISA"));

        Toast filed = page.fileChargeback(txn, "VISA", "13.1", "32.00");
        assertThat(filed.error(), is(false));
        assertThat(filed.text(), containsString("(VISA 13.1)"));
        String disputeId = filed.text().replaceAll(".*Chargeback #(\\d+).*", "$1");

        page.openDispute(disputeId);
        assertThat(page.dialogTitle(), containsString("CHARGEBACK_FILED"));
        assertThat(page.availableActions(), containsInAnyOrder("merchant_accept", "represent", "withdraw"));

        Toast noEvidence = page.disputeAction("represent", null);
        assertThat(noEvidence.error(), is(true));
        assertThat(noEvidence.text(), containsString("requires a note"));

        page.disputeAction("represent", "Signed delivery receipt " + Api.RUN);
        page.waitForDialogState("REPRESENTED");
        assertThat(page.timelineCount(), equalTo(2));

        given().spec(Api.risk()).get("/disputes/{id}", disputeId)
                .then().statusCode(200)
                .body("state", equalTo("REPRESENTED"))
                .body("dispute_amount", equalTo("32.00"))
                .body("events[1].actor", equalTo("merchant"));
    }

    @Test
    @DisplayName("analyst marks a high-amount alert as false positive")
    void reviewAlertFalsePositive() {
        // .<Object>path(...) matters: String.valueOf(path(...)) would pick valueOf(char[]) and fail at runtime
        Object minAmount = given().spec(Api.risk()).get("/fraud/rules")
                .<Object>path("rules.find { it.rule_id == 'HIGH_AMOUNT' }.params.min_amount");
        double threshold = Double.parseDouble(String.valueOf(minAmount));
        String txn = Api.pay(Cards.AMEX, threshold + 100, MERCHANT).path("transaction_id");

        String[] alertId = new String[1];
        Api.waitUntil("HIGH_AMOUNT alert for " + txn, () -> {
            List<Map<String, Object>> alerts = given().spec(Api.risk())
                    .queryParam("rule_id", "HIGH_AMOUNT").get("/fraud/alerts").path("alerts");
            return alerts.stream().filter(a -> txn.equals(a.get("transaction_id"))).findFirst()
                    .map(a -> { alertId[0] = String.valueOf(a.get("alert_id")); return true; }).orElse(false);
        });

        RiskConsolePage page = new RiskConsolePage(driver).open().filterAlerts("OPEN", "HIGH_AMOUNT");
        page.waitForAlert(alertId[0]);

        Toast t = page.reviewAlert(alertId[0], "FALSE_POSITIVE");
        assertThat(t.error(), is(false));
        assertThat(t.text(), containsString("false positive"));

        given().spec(Api.risk()).get("/fraud/alerts/{id}", alertId[0])
                .then().statusCode(200)
                .body("status", equalTo("FALSE_POSITIVE"))
                .body("reviewed_by", equalTo("console"))
                .body("dispute_id", nullValue());
    }

    @Test
    @DisplayName("rules tab rejects an invalid threshold and leaves the rule unchanged")
    void invalidRuleThreshold() {
        Object before = given().spec(Api.risk()).get("/fraud/rules")
                .path("rules.find { it.rule_id == 'VELOCITY' }.params.max_txns");

        Toast t = new RiskConsolePage(driver).open().saveRuleParam("VELOCITY", "max_txns", "0");
        assertThat(t.error(), is(true));
        assertThat(t.text(), containsString("positive integer"));

        Object after = given().spec(Api.risk()).get("/fraud/rules")
                .path("rules.find { it.rule_id == 'VELOCITY' }.params.max_txns");
        assertThat(after, equalTo(before));
    }

    // ---- API helpers for setup / verification ----

    private static boolean activeBlockExists(String last4) {
        List<String> cards = given().spec(Api.risk()).queryParam("active", "true")
                .get("/cards/blocks").path("blocks.card_masked");
        return cards.stream().anyMatch(c -> c.endsWith(last4));
    }

    private static void releaseActiveBlock(String last4) {
        List<Map<String, Object>> blocks = given().spec(Api.risk()).queryParam("active", "true")
                .get("/cards/blocks").path("blocks");
        for (Map<String, Object> b : blocks) {
            if (String.valueOf(b.get("card_masked")).endsWith(last4)) {
                given().spec(Api.risk()).body(Map.of("analyst", "java-tests"))
                        .post("/cards/blocks/{id}/release", b.get("block_id"));
            }
        }
    }
}
