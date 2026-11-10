package lab.support;

import java.util.Map;

/** The simulator's published test cards (backend/server.js TEST_CARDS). Never use real card numbers. */
public final class Cards {
    private Cards() {}

    public static final String VISA = "4111111111111111";
    public static final String MASTERCARD = "5555555555554444";
    public static final String AMEX = "378282246310005";
    public static final String DISCOVER = "6011111111111117";
    public static final String VISA_INSUFFICIENT_FUNDS = "4000000000000002"; // DE39 51
    public static final String VISA_LOST = "4000000000009987";               // DE39 41

    /** Approved card for each network, keyed by the simulator's card_brand value. */
    public static final Map<String, String> APPROVED_BY_BRAND = Map.of(
            "VISA", VISA,
            "MASTERCARD", MASTERCARD,
            "AMEX", AMEX,
            "DISCOVER", DISCOVER);

    /** The simulator's mask format: four bullets, a space, last 4 digits. */
    public static String masked(String pan) {
        return "•••• " + pan.substring(pan.length() - 4);
    }
}
