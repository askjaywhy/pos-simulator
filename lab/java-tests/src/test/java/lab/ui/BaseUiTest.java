package lab.ui;

import lab.support.Api;
import lab.support.Config;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.extension.AfterTestExecutionCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.openqa.selenium.Dimension;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.remote.RemoteWebDriver;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * Starts a browser per test: Selenium Grid when SELENIUM_URL is set (Docker),
 * otherwise a local Chrome. Saves a screenshot to target/screenshots when a test fails.
 */
abstract class BaseUiTest {

    protected WebDriver driver;

    @RegisterExtension
    final AfterTestExecutionCallback screenshotOnFailure = this::screenshotIfFailed;

    @BeforeEach
    void startBrowser() {
        ChromeOptions options = new ChromeOptions();
        options.addArguments("--window-size=1400,900", "--disable-gpu");
        if (Config.SELENIUM_URL.isEmpty()) {
            options.addArguments("--headless=new");
            driver = new ChromeDriver(options); // Selenium Manager downloads the matching driver
        } else {
            driver = connectToGrid(options);
        }
        driver.manage().window().setSize(new Dimension(1400, 900));
    }

    @AfterEach
    void stopBrowser() {
        if (driver != null) driver.quit();
    }

    /** The Grid container can take a few seconds to accept sessions after it starts. */
    private WebDriver connectToGrid(ChromeOptions options) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= 20; attempt++) {
            try {
                return new RemoteWebDriver(URI.create(Config.SELENIUM_URL).toURL(), options);
            } catch (Exception e) {
                last = e instanceof RuntimeException re ? re : new RuntimeException(e);
                Api.sleep(3000);
            }
        }
        throw new IllegalStateException("Could not start a browser on Selenium Grid at " + Config.SELENIUM_URL, last);
    }

    private void screenshotIfFailed(ExtensionContext context) {
        if (context.getExecutionException().isEmpty() || driver == null) return;
        try {
            Path dir = Path.of("target", "screenshots");
            Files.createDirectories(dir);
            Path src = ((TakesScreenshot) driver).getScreenshotAs(OutputType.FILE).toPath();
            String name = context.getRequiredTestClass().getSimpleName() + "-" + context.getRequiredTestMethod().getName() + ".png";
            Files.copy(src, dir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
            System.out.println("Screenshot saved: " + dir.resolve(name));
        } catch (IOException | RuntimeException e) {
            System.out.println("Could not save screenshot: " + e.getMessage());
        }
    }
}
