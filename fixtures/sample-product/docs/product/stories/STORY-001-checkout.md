---
id: STORY-001
title: Check out a cart
status: accepted
persona: PER-001
want: to pay for my cart in one step
soThat: my order is placed without re-entering items
jobs: [JOB-001]
activity: Buy
step: Pay
release: MVP
priority: must
code:
  - src/api/cart.ts#checkout
  - POST /checkout
---

# Check out a cart

## Acceptance criteria

```gherkin
@AC-1
Scenario: Add an item and see it in the cart
  Given an empty cart
  When the shopper adds "sku-1"
  Then the cart lists "sku-1"

@AC-2
Scenario: Payment declined keeps the cart
  Given a cart with "sku-1"
  When the payment is declined
  Then the cart still lists "sku-1"
  And the shopper sees why the payment failed

Scenario: Untagged scenario
  Given something
  When something happens
```

## Requirements (EARS)

- **REQ-1** WHEN the payment provider declines THE shop SHALL keep the cart unchanged
- **REQ-2** the shop is fast
