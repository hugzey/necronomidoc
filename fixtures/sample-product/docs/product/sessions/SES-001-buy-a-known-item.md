---
id: SES-001
title: Returning shopper buys a known item
status: accepted
persona: PER-001
job: JOB-001
intent: "I need sku-1 again — just let me pay for it."
trigger: Ran out of the item at home
entry:
  channel: web
  auth: signed in as customer
  preconditions:
    - The shopper has a saved payment method
steps:
  - id: S1
    action: Opens the cart
    surface: "`CartPage`"
    expects: Cart shows its items
    emotion: 4
  - id: S2
    action: Adds the item
    system: POST /cart/items
    code: [src/api/cart.ts#addToCart]
    expects: Item appears in the cart
    emotion: 4
  - id: S3
    action: Checks out
    system: POST /checkout
    code: [src/api/cart.ts#checkout, src/api/removed.ts#gone]
    expects: Order confirmation
    emotion: 5
    outcome: OUT-1
    branches:
      - when: Payment is declined
        goto: S4
  - id: S4
    action: Sees the decline reason and leaves
    expects: The cart is still there for later
    emotion: 2
    outcome: OUT-2
outcomes:
  - id: OUT-1
    kind: fulfilled
    title: Order placed
    criteria:
      - "`OrderPage` shows the order id"
  - id: OUT-2
    kind: abandoned
    title: Leaves after a declined payment, cart intact
    criteria:
      - Cart still holds the item
stories: [STORY-001]
journey: { id: JRN-001, stage: Buy }
metrics:
  - Intent fulfilled in 3 steps
---

# Returning shopper buys a known item

## Narrative

A returning shopper opens the cart, adds the item, and pays.
