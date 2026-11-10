package lab.bdd;

import io.cucumber.java.en.And;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;
import lab.support.Api;
import lab.support.Cards;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.*;

/** Step definitions for chargeback.feature. Cucumber creates a new instance per scenario. */
public class ChargebackSteps {

    private static final String MERCHANT = "JAVA-BDD-" + Api.RUN;

    private String transactionId;
    private String disputeId;
    private Response last;

    @Given("the risk service is healthy")
    public void riskServiceHealthy() {
        given().spec(Api.risk()).get("/health").then().statusCode(200);
    }

    @Given("an approved {word} transaction for ${double}")
    public void approvedTransaction(String brand, double amount) {
        String card = Cards.APPROVED_BY_BRAND.get(brand);
        assertThat("no test card for brand " + brand, card, notNullValue());
        Response r = Api.pay(card, amount, MERCHANT);
        assertThat(r.<String>path("status"), equalTo("APPROVED"));
        transactionId = r.path("transaction_id");
        Api.waitLoaded(transactionId);
    }

    @When("the issuer files a chargeback with reason code {string}")
    public void fileChargeback(String code) {
        file(code, null);
    }

    @When("the issuer files a chargeback with reason code {string} for ${double}")
    public void fileChargebackForAmount(String code, double amount) {
        file(code, amount);
    }

    @And("the merchant represents with {string}")
    public void merchantRepresents(String evidence) {
        act("represent", evidence);
    }

    @And("the merchant represents without evidence")
    public void merchantRepresentsWithoutEvidence() {
        act("represent", null);
    }

    @And("the issuer files pre-arbitration with {string}")
    public void preArbitration(String rationale) {
        act("pre_arbitration", rationale);
    }

    @And("the merchant escalates to arbitration")
    public void escalate() {
        act("escalate_arbitration", null);
    }

    @And("the network rules for the merchant")
    public void rulingMerchant() {
        act("ruling_merchant", null);
    }

    @And("the merchant accepts the chargeback")
    public void merchantAccepts() {
        act("merchant_accept", null);
    }

    @And("the issuer accepts the representment")
    public void issuerAccepts() {
        act("issuer_accept", null);
    }

    @Then("the response status is {int}")
    public void responseStatus(int status) {
        assertThat("HTTP status. Body: " + last.asString(), last.statusCode(), equalTo(status));
    }

    @Then("the dispute is {string}")
    public void disputeState(String state) {
        assertThat(dispute().<String>path("state"), equalTo(state));
    }

    @And("liability rests with the {string}")
    public void liability(String party) {
        assertThat(dispute().<String>path("liability"), equalTo(party));
    }

    @And("the provisional credit is reversed")
    public void creditReversed() {
        assertThat(dispute().<Boolean>path("provisional_credit"), is(false));
    }

    @And("the cardholder keeps the provisional credit")
    public void creditKept() {
        assertThat(dispute().<Boolean>path("provisional_credit"), is(true));
    }

    @And("the audit trail has {int} events")
    public void auditTrail(int count) {
        List<Map<String, Object>> events = dispute().path("events");
        assertThat(events, hasSize(count));
        assertThat(events.get(0).get("action"), equalTo("file_chargeback"));
    }

    @And("the allowed actions include {string}")
    public void allowedActionsInclude(String action) {
        List<String> allowed = last.path("allowed_actions");
        assertThat(allowed, hasItem(action));
    }

    // ---------- helpers ----------

    private void file(String code, Double amount) {
        Map<String, Object> body = new HashMap<>();
        body.put("transaction_id", transactionId);
        body.put("reason_code", code);
        body.put("note", "BDD scenario " + Api.RUN);
        if (amount != null) body.put("amount", amount);
        last = given().spec(Api.risk()).body(body).post("/disputes");
        if (last.statusCode() == 201) disputeId = String.valueOf(last.<Object>path("dispute_id"));
    }

    private void act(String action, String note) {
        assertThat("no dispute was filed in this scenario", disputeId, notNullValue());
        Map<String, Object> body = new HashMap<>();
        body.put("action", action);
        body.put("note", note);
        last = given().spec(Api.risk()).body(body).post("/disputes/{id}/actions", disputeId);
    }

    private Response dispute() {
        assertThat("no dispute was filed in this scenario", disputeId, notNullValue());
        return given().spec(Api.risk()).get("/disputes/{id}", disputeId)
                .then().statusCode(200).extract().response();
    }
}
