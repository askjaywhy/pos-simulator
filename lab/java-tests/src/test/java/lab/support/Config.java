package lab.support;

/**
 * Endpoints, read from environment variables so the same tests run in Docker
 * (service names) or on Windows directly (localhost defaults).
 */
public final class Config {
    private Config() {}

    /** POS simulator API, e.g. http://localhost:3001/api */
    public static final String POS_API = env("POS_API", "http://localhost:3001/api");

    /** Risk service API, e.g. http://localhost:3002/api */
    public static final String RISK_API = env("RISK_API", "http://localhost:3002/api");

    /** Risk console URL as the browser sees it (from inside the Selenium container: http://risk-service:3002) */
    public static final String CONSOLE_URL = env("CONSOLE_URL", "http://localhost:3002");

    /** Selenium Grid URL. Empty = launch a local Chrome instead. */
    public static final String SELENIUM_URL = env("SELENIUM_URL", "");

    /** How long to wait for asynchronous pipeline work (Kafka -> Postgres / fraud engine). */
    public static final int PIPELINE_TIMEOUT_SECONDS = Integer.parseInt(env("PIPELINE_TIMEOUT_SECONDS", "60"));

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? fallback : v.trim();
    }
}
