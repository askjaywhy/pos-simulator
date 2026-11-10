package lab.ui.pages;

import lab.support.Config;
import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.Select;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.time.Duration;
import java.util.List;

/**
 * Page object for the Risk Console (risk/public/index.html).
 * Tests talk to this class, never to raw locators, so a UI change is fixed in one place.
 */
public class RiskConsolePage {

    private final WebDriver driver;
    private final WebDriverWait wait;

    // ---- locators ----
    private static final By BLOCK_CARD = By.id("block-card");
    private static final By BLOCK_REASON = By.id("block-reason");
    private static final By BLOCK_SUBMIT = By.cssSelector("#block-form button[type=submit]");
    private static final By BLOCK_ROWS = By.cssSelector("[data-testid=block-row]");
    private static final By DISPUTE_TXN = By.id("dispute-txn");
    private static final By DISPUTE_NETWORK = By.id("dispute-network");
    private static final By DISPUTE_REASON = By.id("dispute-reason");
    private static final By DISPUTE_AMOUNT = By.id("dispute-amount");
    private static final By DISPUTE_SUBMIT = By.cssSelector("#dispute-form button[type=submit]");
    private static final By DIALOG = By.id("dispute-dialog");
    private static final By DIALOG_TITLE = By.id("dd-title");
    private static final By DIALOG_NOTE = By.id("dd-note");
    private static final By TIMELINE_ITEMS = By.cssSelector("#dd-timeline li");
    private static final By ALERT_RULE = By.id("alert-rule");
    private static final By ALERT_STATUS = By.id("alert-status");

    public RiskConsolePage(WebDriver driver) {
        this.driver = driver;
        this.wait = new WebDriverWait(driver, Duration.ofSeconds(15));
    }

    public RiskConsolePage open() {
        driver.get(Config.CONSOLE_URL);
        // header KPIs start as "–" and fill in once /api/summary answers
        wait.until(d -> !kpi("kpi-open-alerts").equals("–"));
        return this;
    }

    public String kpi(String testId) {
        return driver.findElement(By.cssSelector("[data-testid=" + testId + "]")).getText().trim();
    }

    public RiskConsolePage openTab(String tab) {
        driver.findElement(By.cssSelector("nav [data-tab=" + tab + "]")).click();
        wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("tab-" + tab)));
        return this;
    }

    public boolean isTabSelected(String tab) {
        return "true".equals(driver.findElement(By.cssSelector("nav [data-tab=" + tab + "]")).getAttribute("aria-selected"));
    }

    public int rowCount(String tableTestId, String rowTestId) {
        wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("[data-testid=" + tableTestId + "]")));
        return driver.findElements(By.cssSelector("[data-testid=" + rowTestId + "]")).size();
    }

    // ---- toast (status message) ----

    /** Run a UI action and return the toast message it produces. */
    public Toast actAndReadToast(Runnable action) {
        JavascriptExecutor js = (JavascriptExecutor) driver;
        js.executeScript("document.getElementById('toast').textContent = '';");
        action.run();
        // Read textContent through JS, not getText(): the toast fades in and out with CSS opacity,
        // and Selenium's getText() returns "" for an element it considers not displayed.
        wait.until(d -> !String.valueOf(js.executeScript("return document.getElementById('toast').textContent")).isBlank());
        String text = String.valueOf(js.executeScript("return document.getElementById('toast').textContent")).trim();
        boolean error = String.valueOf(js.executeScript("return document.getElementById('toast').className")).contains("error");
        return new Toast(text, error);
    }

    public record Toast(String text, boolean error) {}

    // ---- card blocks ----

    public Toast blockCard(String last4, String reason) {
        openTab("blocks");
        driver.findElement(BLOCK_CARD).clear();
        driver.findElement(BLOCK_CARD).sendKeys(last4);
        driver.findElement(BLOCK_REASON).clear();
        driver.findElement(BLOCK_REASON).sendKeys(reason);
        return actAndReadToast(() -> driver.findElement(BLOCK_SUBMIT).click());
    }

    /** Text of every visible block row, e.g. "12 •••• 1117 reason analyst:console ... Active Release". */
    public List<String> blockRows() {
        return driver.findElements(BLOCK_ROWS).stream().map(WebElement::getText).toList();
    }

    public Toast releaseBlockForCard(String last4) {
        WebElement row = driver.findElements(BLOCK_ROWS).stream()
                .filter(r -> r.getText().contains("•••• " + last4) && r.getText().contains("Active"))
                .findFirst().orElseThrow(() -> new AssertionError("No active block row for " + last4));
        return actAndReadToast(() -> row.findElement(By.cssSelector("[data-release]")).click());
    }

    // ---- disputes ----

    public Toast fileChargeback(String transactionId, String network, String reasonCode, String amount) {
        openTab("disputes");
        driver.findElement(DISPUTE_TXN).clear();
        driver.findElement(DISPUTE_TXN).sendKeys(transactionId);
        // the network <option>s have no value attribute, so select by their text
        new Select(driver.findElement(DISPUTE_NETWORK)).selectByVisibleText(network);
        // reason codes reload asynchronously for the chosen network
        wait.until(ExpectedConditions.presenceOfElementLocated(
                By.cssSelector("#dispute-reason option[value='" + reasonCode + "']")));
        new Select(driver.findElement(DISPUTE_REASON)).selectByValue(reasonCode);
        driver.findElement(DISPUTE_AMOUNT).clear();
        if (amount != null) driver.findElement(DISPUTE_AMOUNT).sendKeys(amount);
        return actAndReadToast(() -> driver.findElement(DISPUTE_SUBMIT).click());
    }

    public RiskConsolePage openDispute(String disputeId) {
        By open = By.cssSelector("[data-open='" + disputeId + "']");
        wait.until(ExpectedConditions.elementToBeClickable(open)).click();
        wait.until(d -> d.findElement(DIALOG).getAttribute("open") != null);
        return this;
    }

    public Toast disputeAction(String action, String note) {
        driver.findElement(DIALOG_NOTE).clear();
        if (note != null) driver.findElement(DIALOG_NOTE).sendKeys(note);
        By button = By.cssSelector("#dd-actions [data-action=" + action + "]");
        return actAndReadToast(() -> wait.until(ExpectedConditions.elementToBeClickable(button)).click());
    }

    public String dialogTitle() {
        return driver.findElement(DIALOG_TITLE).getText();
    }

    public void waitForDialogState(String state) {
        wait.until(ExpectedConditions.textToBePresentInElementLocated(DIALOG_TITLE, state));
    }

    public int timelineCount() {
        return driver.findElements(TIMELINE_ITEMS).size();
    }

    public List<String> availableActions() {
        return driver.findElements(By.cssSelector("#dd-actions [data-action]")).stream()
                .map(e -> e.getAttribute("data-action")).toList();
    }

    // ---- alerts ----

    public RiskConsolePage filterAlerts(String status, String rule) {
        openTab("alerts");
        new Select(driver.findElement(ALERT_STATUS)).selectByValue(status);
        // rule <option>s have no value attribute (except "All"), so select by their text
        new Select(driver.findElement(ALERT_RULE)).selectByVisibleText(rule);
        return this;
    }

    public boolean alertVisible(String alertId) {
        return !driver.findElements(By.cssSelector("[data-alert-id='" + alertId + "']")).isEmpty();
    }

    public void waitForAlert(String alertId) {
        wait.until(ExpectedConditions.presenceOfElementLocated(By.cssSelector("[data-alert-id='" + alertId + "']")));
    }

    public Toast reviewAlert(String alertId, String decision) {
        By button = By.cssSelector("[data-review=" + decision + "][data-id='" + alertId + "']");
        return actAndReadToast(() -> wait.until(ExpectedConditions.elementToBeClickable(button)).click());
    }

    // ---- rules ----

    public Toast saveRuleParam(String ruleId, String param, String value) {
        openTab("rules");
        By input = By.cssSelector("tr[data-rule=" + ruleId + "] input[data-p=" + param + "]");
        WebElement field = wait.until(ExpectedConditions.visibilityOfElementLocated(input));
        field.clear();
        field.sendKeys(value);
        return actAndReadToast(() -> driver.findElement(By.cssSelector("[data-save=" + ruleId + "]")).click());
    }
}
