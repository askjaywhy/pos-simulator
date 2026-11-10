package lab.bdd;

import org.junit.platform.suite.api.ConfigurationParameter;
import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

import static io.cucumber.junit.platform.engine.Constants.GLUE_PROPERTY_NAME;

/**
 * Runs every .feature file under src/test/resources/features with Cucumber.
 * failIfNoTests = false: a tag-filtered run (e.g. -Dgroups=known-defect) selects no scenarios, which is fine.
 */
@Suite(failIfNoTests = false)
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
@ConfigurationParameter(key = GLUE_PROPERTY_NAME, value = "lab.bdd")
public class RunCucumberTest {
}
