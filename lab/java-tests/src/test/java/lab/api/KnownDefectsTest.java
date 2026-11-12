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

    // All logged defects (DEF-001 to DEF-008) are fixed; their tests now live in SimulatorApiTest.
    // Add a test here, tagged known-defect, for each newly found defect until it is fixed.
}
