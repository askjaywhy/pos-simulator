Feature: Chargeback lifecycle
  As an issuer dispute analyst
  I need chargebacks to follow card-network rules
  So that liability and cardholder credit end up with the right party

  Background:
    Given the risk service is healthy

  Scenario Outline: Reason codes must belong to the card's network
    Given an approved <brand> transaction for $<amount>
    When the issuer files a chargeback with reason code "<code>"
    Then the response status is <status>

    Examples:
      | brand      | amount | code | status |
      | VISA       | 30.00  | 13.1 | 201    |
      | VISA       | 30.00  | 4853 | 422    |
      | MASTERCARD | 45.00  | 4853 | 201    |
      | AMEX       | 60.00  | C08  | 201    |
      | AMEX       | 60.00  | 10.4 | 422    |
      | DISCOVER   | 25.00  | RG   | 201    |

  Scenario: Merchant wins at arbitration
    Given an approved VISA transaction for $120.00
    When the issuer files a chargeback with reason code "13.1" for $60.00
    And the merchant represents with "Signed proof of delivery, carrier tracking attached"
    And the issuer files pre-arbitration with "Cardholder says the signature is not theirs"
    And the merchant escalates to arbitration
    And the network rules for the merchant
    Then the dispute is "CLOSED_MERCHANT_WON"
    And liability rests with the "cardholder"
    And the provisional credit is reversed
    And the audit trail has 5 events

  Scenario: Merchant accepts the chargeback
    Given an approved MASTERCARD transaction for $35.50
    When the issuer files a chargeback with reason code "4853"
    And the merchant accepts the chargeback
    Then the dispute is "CLOSED_CARDHOLDER_WON"
    And liability rests with the "merchant"
    And the cardholder keeps the provisional credit
    And the audit trail has 2 events

  Scenario: Issuer accepts the representment
    Given an approved DISCOVER transaction for $89.99
    When the issuer files a chargeback with reason code "RG"
    And the merchant represents with "Delivery confirmation and customer emails"
    And the issuer accepts the representment
    Then the dispute is "CLOSED_MERCHANT_WON"
    And the provisional credit is reversed

  Scenario: Actions out of order are rejected
    Given an approved AMEX transaction for $210.00
    When the issuer files a chargeback with reason code "C08"
    And the network rules for the merchant
    Then the response status is 409
    And the allowed actions include "represent"
    And the dispute is "CHARGEBACK_FILED"

  Scenario: Representment requires evidence
    Given an approved VISA transaction for $15.00
    When the issuer files a chargeback with reason code "13.7"
    And the merchant represents without evidence
    Then the response status is 422
    And the dispute is "CHARGEBACK_FILED"

  Scenario: A closed dispute accepts no further actions
    Given an approved VISA transaction for $22.00
    When the issuer files a chargeback with reason code "12.6.1"
    And the merchant accepts the chargeback
    And the merchant represents with "Too late"
    Then the response status is 409
    And the dispute is "CLOSED_CARDHOLDER_WON"
