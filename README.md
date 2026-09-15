<p align="center">
  <img src="https://raw.githubusercontent.com/Bin-E-Commerce/Bin-E-Commerce-UI-Web/main/public/images/logo/logo_background_white.png" alt="Bin E-Commerce" width="190" />
</p>

<h1 align="center">Order Service</h1>

<p align="center">
  Turn a cart into one reliable order, preserve what the customer agreed to, and coordinate every next step.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PostgreSQL-TypeORM-336791?logo=postgresql&logoColor=white" alt="PostgreSQL and TypeORM" />
  <img src="https://img.shields.io/badge/Kafka-events-231F20?logo=apachekafka&logoColor=white" alt="Kafka" />
  <img src="https://img.shields.io/badge/COD-payment-0F766E" alt="Cash on delivery" />
  <img src="https://img.shields.io/badge/Returns-lifecycle-B45309" alt="Returns lifecycle" />
</p>

## Contents

1. [Problem](#1-problem)
2. [Service at a glance](#2-service-at-a-glance)
3. [Service Boundary](#3-service-boundary)
4. [Architecture](#4-architecture)
5. [Trust surface](#5-trust-surface)
6. [See It Work](#6-see-it-work)
7. [Install](#7-install)
8. [Checkout Overview](#8-checkout-overview)
9. [Quote Flow](#9-quote-flow)
10. [Create Order Flow](#10-create-order-flow)
11. [Order Lifecycle](#11-order-lifecycle)
12. [Delivery Confirmation](#12-delivery-confirmation)
13. [Returns and Refunds](#13-returns-and-refunds)
14. [Seller Operations](#14-seller-operations)
15. [Event and Outbox Flow](#15-event-and-outbox-flow)
16. [API Surface](#16-api-surface)
17. [Data Model](#17-data-model)
18. [Consistency and Concurrency](#18-consistency-and-concurrency)
19. [Project Structure](#19-project-structure)
20. [Configuration Reference](#20-configuration-reference)
21. [Development](#21-development)
22. [Testing Strategy](#22-testing-strategy)
23. [Security and Privacy](#23-security-and-privacy)
24. [Operational Notes](#24-operational-notes)
25. [Documentation Findings](#25-documentation-findings)
26. [FAQ](#26-faq)
27. [Ownership](#27-ownership)

## 1. Problem

Checkout is a cross-domain workflow. A customer chooses items from Cart, Product Service owns the current price and inventory, Auth Service owns the customer's saved address, Seller Service owns shop context, Shipping calculates delivery cost, and Notification/Recommendation consume the resulting events.

The platform needs one service to create an order that remains historically correct even when those source systems change later. Without that boundary, common failures include:

- A client submits its own price, seller ID or shipping fee.
- An order is created twice because a browser retries after a network timeout.
- Inventory is reserved but no order is committed.
- A product name or price changes and silently rewrites an old order.
- Seller views expose items from another shop in a multi-seller order.
- A delivery issue changes the wrong fulfillment state.
- Return/refund money is calculated differently by customer and seller screens.
- Kafka delivery failures make purchase signals disappear without an audit trail.

Order Service solves the order-side of these problems. It validates checkout context, obtains current domain data through service contracts, reserves inventory, persists order and item snapshots, maintains lifecycle history, coordinates delivery/return transitions and publishes integration events.

The service currently supports a COD payment method. Payment provider integration is intentionally not treated as implemented just because a payment status enum exists.

## 2. Service at a glance

| Attribute | Value |
| --- | --- |
| Service | order-service |
| Default port | 3011 |
| HTTP prefix | /api |
| URI version | v1 |
| Development docs | /docs |
| Health endpoint | /api/health |
| Primary database | PostgreSQL + TypeORM |
| Payment method currently supported | COD |
| Synchronous dependencies | Cart, Product, Auth, Seller, Shipping |
| Event transport | Kafka |
| Main role | Order aggregate and fulfillment orchestration |

### Runtime responsibilities

Order Service answers:

1. What was purchased, by whom and under which seller/shop?
2. What price, address, shipping quote and product information were accepted at checkout?
3. Which order and fulfillment transition is legal now?
4. Which customer/seller/internal view is allowed to see this order?
5. Which purchase, delivery and return events need to be emitted?

It does not own the current product catalog, cart contents, user profile, shop profile, shipment provider state or notification delivery.

## 3. Service Boundary

### Order Service owns

| Boundary | Responsibility |
| --- | --- |
| Order aggregate | Order identity, order number, owner and lifecycle state |
| Checkout commit | Create COD order from the active cart |
| Historical snapshots | Item, seller/shop, category, package and shipping address snapshots |
| Status history | Auditable order transition timeline |
| Fulfillment status | To ship, shipping, delivered, completed, cancelled, failed and return/refund state |
| Delivery confirmation | Customer confirmation, issue reporting and automatic confirmation |
| Return request | Customer request, seller review, inspection and refund stages |
| Seller projection | Owner-scoped item/order views and seller return actions |
| Purchase integration | Completed-purchase event and replay/outbox boundary |

### Other services own

| Concern | Source of truth |
| --- | --- |
| Active cart | Cart Service |
| Current product/variant price and stock | Product Service |
| User and saved address | Auth Service |
| Shop ownership/profile | Seller Service |
| Shipment/provider status | Shipping Service |
| Email and notification delivery | Notification Service |
| Recommendation profile/ranking | Recommendation Service |
| Identity verification at the edge | API Gateway and Keycloak |

### Ownership rule

Order stores the facts needed to preserve an historical transaction. It does not use those snapshots as a replacement for current Product, Seller or Shipping state during a new operation.

## 4. Architecture

~~~text
Customer / Seller / Internal caller
                |
                v
          API Gateway
                |
                v
          Order Service
       /       |        \
      v        v         v
   Cart     Product     Auth
                         |
        Seller <------ Shipping
                |
                v
             PostgreSQL
                |
                +--> Kafka / purchase outbox
                +--> shipment status consumer
~~~

### Application layers

- Presentation controllers define customer, seller and internal contracts.
- DTOs validate checkout, cancellation, delivery and return input.
- Application services coordinate transactions and domain transitions.
- Integration clients call Cart, Product, Auth, Seller and Shipping contracts.
- Repositories persist order aggregates, snapshots, history, returns, issues and outbox records.
- Kafka producer/consumer handles asynchronous integration without moving business rules into transport code.

### Bootstrap contract

The current HTTP bootstrap:

- Loads environment configuration.
- Enables Helmet.
- Uses the /api prefix and URI version 1.
- Applies whitelist, forbidden-field and transform validation.
- Disables direct CORS origins because browser traffic is expected to use the Gateway.
- Exposes Swagger only outside production.
- Enables graceful shutdown.

The service also starts a shipment status consumer. Kafka connection failure is treated as non-fatal to HTTP startup, but it must be monitored because delivery synchronization and purchase event publication depend on it.

## 5. Trust surface

<details>
<summary>What Order Service trusts and rejects</summary>

### Trusted after validation

- Customer identity from the verified Gateway context.
- Cart identity resolved by the Cart contract.
- Current product/variant status, price and stock from Product Service.
- Saved address data from Auth Service.
- Shop/pickup information from Seller or Shipping contracts.
- Internal service requests protected by the internal token and route contract.
- Shipment status events that match the expected event shape and order identity.

### Never trusted directly

- Product price, line total, shipping fee or seller identity from the browser.
- A cart ID chosen to access another customer's cart.
- An order ID without an owner/seller/internal authorization check.
- A return reason outside the supported enum.
- A customer claim that a transition is legal without checking current state.
- A Kafka event that has no order ID or cannot be mapped safely.

Every customer read and mutation is owner-scoped. Seller views additionally filter order items by the seller's shop/owner context; a multi-seller order must not become a data-leak shortcut.

</details>

## 6. See It Work

### 6.1. Start local

~~~powershell
cd services/order-service
Copy-Item .env.example .env
npm install
npm run dev
~~~

The service expects PostgreSQL and the configured Cart, Product, Auth, Seller and Kafka dependencies. Shipping is required for real delivery quote behavior.

### 6.2. Check health and docs

~~~powershell
curl http://localhost:3011/api/health
~~~

Open http://localhost:3011/docs in development to inspect the generated order contract.

### 6.3. Request a quote

~~~powershell
curl -X POST http://localhost:3011/api/v1/orders/quote -H "Authorization: Bearer <keycloak-access-token>" -H "Content-Type: application/json" -d '{"shippingAddressId":"<address-uuid>","paymentMethod":"COD"}'
~~~

The quote is calculated from server-side cart/address/product data. It is not a permanent reservation or a guarantee that the same inventory will still be available at commit time.

### 6.4. Create an idempotent COD order

~~~powershell
curl -X POST http://localhost:3011/api/v1/orders -H "Authorization: Bearer <keycloak-access-token>" -H "Idempotency-Key: checkout-unique-key-001" -H "Content-Type: application/json" -d '{"shippingAddressId":"<address-uuid>","paymentMethod":"COD"}'
~~~

Use a new key for a genuinely new checkout attempt and reuse the same key when retrying the same request after an uncertain network result.

## 7. Install

> [!IMPORTANT]
> Order Service is stateful and controls a financial/fulfillment history. It requires PostgreSQL, trusted downstream contracts and Kafka. Do not edit production order rows manually, reuse customer data in local tests or treat the checkout snapshot as current inventory truth.

### Required dependencies

| Dependency | Why it is required |
| --- | --- |
| PostgreSQL | Order, item, history, return, delivery issue and outbox persistence |
| Cart Service | Active cart lookup and checkout transition |
| Product Service | Quote, current price and inventory reservation/release |
| Auth Service | User/address ownership and identity details |
| Seller Service | Shop ownership and seller context |
| Shipping Service | Delivery fee and shipment context |
| Kafka | Purchase/return/order events and shipment status consumer |

### Local build

~~~powershell
cd services/order-service
Copy-Item .env.example .env
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
npm run start
~~~

### Recovery and rollback

An order is an audit record. Code rollback does not erase an order, release inventory automatically or retract a notification. Recovery uses explicit compensating operations: cancel/release, shipment reconciliation, return/refund transition and event replay.

## 8. Checkout Overview

~~~text
Customer
   |
   +--> quote
   |      -> read active cart
   |      -> resolve address
   |      -> validate product/variant
   |      -> calculate shipping
   |
   +--> create order
          -> idempotency check
          -> reserve inventory
          -> calculate/confirm shipping
          -> persist order snapshots
          -> close cart
          -> persist purchase outbox
          -> publish integration events
~~~

### Checkout invariants

- The client never determines the final item price.
- Order creation is scoped to the authenticated owner.
- The same owner and idempotency key cannot create two different orders.
- Reservation and order creation have a defined compensation path.
- The historical address/item/package data is stored at commit.
- Event publication cannot silently change the order's committed state.

## 9. Quote Flow

~~~text
POST /orders/quote
       |
       v
validate address ID and payment method
       |
       v
Cart active lookup
       |
       v
Auth address ownership lookup
       |
       v
Product quote/read contract
       |
       v
Shipping quote per shop/package
       |
       v
return subtotal + shipping breakdown + total
~~~

The shipping client sends an internal quote request to Shipping Service. Pickup addresses are resolved server-side, so a browser cannot select an arbitrary shop pickup location.

### Quote limitations

- A quote can become stale when price, inventory or shipping availability changes.
- Quote response does not commit an order.
- Quote failure must not create an order or mutate the cart.
- The create-order path must repeat critical validation.

## 10. Create Order Flow

~~~text
1. Validate owner and idempotency key
2. Look for an existing order by owner + key
3. Reject a mismatched request fingerprint
4. Read current address and active cart
5. Reserve current product quantities
6. Calculate shipping from the reservation snapshot
7. Persist order, item snapshots and status history
8. Mark the cart checked out
9. Persist purchase outbox data
10. Publish order/purchase events
11. Return the order response
~~~

### Idempotency behavior

The order entity has an owner-scoped idempotency key and request fingerprint. A retry with the same owner/key can return the existing order when the request is equivalent. Reusing the key for a different request must not silently mutate the existing order.

### Compensation

If inventory is reserved but order persistence fails, the application attempts to release the reservation. If a concurrent order already owns the reservation, compensation must not release inventory belonging to that other order. This is why the reservation key and concurrent-order handling are part of the application contract.

### Payment scope

Current checkout supports COD. The payment status tracks COD collection/refund stages, but no external payment gateway should be assumed from these enums alone.

## 11. Order Lifecycle

### Legacy order status

~~~text
PENDING -> CONFIRMED -> CANCELLED
             |
             +-> FAILED
~~~

The legacy order status remains for compatibility with existing phases and data.

### Fulfillment status

~~~text
TO_SHIP -> SHIPPING -> DELIVERED -> COMPLETED
   |          |           |
   +------> CANCELLED     +-> RETURN_REFUND
              |
              +-> DELIVERY_FAILED
~~~

Fulfillment status is separate from payment status. A COD order can be ready to ship while payment is still pending collection.

### Status history

Every important order transition should write status history with from status, to status, actor/source and reason. The response mapper exposes the timeline for customer/seller audit views.

## 12. Delivery Confirmation

### Provider update

Shipping Service publishes shipment status. The Order consumer reads shipment.status.updated and delegates the transition to an application service using a pessimistic write lock and replay-safe rules.

~~~text
shipment.status.updated
       -> validate order ID/status
       -> lock order
       -> apply only a forward-valid transition
       -> set delivered/deadline fields
       -> write history
       -> publish delivery event
~~~

### Customer decision

After delivery, the customer can confirm receipt or report an issue. The delivery confirmation record separates:

- Pending confirmation.
- Customer confirmed.
- Issue reported.
- Automatically confirmed.

An issue can include affected item IDs, evidence and reason. The service keeps delivery issue state separate from the legacy cancelled order status.

### Automatic completion

A worker can auto-complete an order after the configured delivery-confirmation deadline. It rechecks the deadline inside a locked transaction so a concurrent customer action cannot be overwritten incorrectly.

## 13. Returns and Refunds

### Return request lifecycle

~~~text
REQUESTED
    -> APPROVED -> AWAITING_SHIPMENT -> IN_TRANSIT
    -> REJECTED
    -> CUSTOMER_CANCELLED

IN_TRANSIT -> RECEIVED -> INSPECTION_PASSED -> REFUND_PENDING -> REFUNDED
                    \-> INSPECTION_FAILED
IN_TRANSIT -> SHIPMENT_FAILED
REFUND_PENDING -> REFUND_FAILED
~~~

The supported return reasons include damaged, wrong item, missing item, not as described, change of mind and other. Evidence and item IDs are stored as controlled JSON snapshots so later changes to product/media records do not erase the return context.

### Ownership and shop scope

Returns are scoped by order, owner and shop. The active-return unique index prevents multiple active return requests for the same order/shop combination. Seller review sees only the items belonging to that seller's shop.

### Money rules

The return service separates:

- Refund item amount.
- Refund shipping amount.
- Return shipping fee charged to the customer.
- Return shipping cost.
- Total refund amount.

Seller-fault reasons can affect refundable outbound shipping according to the application rule. Money is normalized using integer-cent arithmetic and explicit rounding rather than floating-point accumulation.

### Review and inspection

Seller actions are approve, reject and inspection. Inspection outcome drives refund progression; it does not silently delete the return request or rewrite the original order snapshot.

## 14. Seller Operations

Seller views are not simply customer views with a different label. A multi-seller order is filtered to the current seller's shop/order items.

### Seller capabilities

- List seller orders with status/fulfillment filters and pagination.
- Read a seller-scoped order detail.
- List seller return requests.
- Approve or reject a return.
- Record inspection outcome.
- Consume shipping/order context through internal contracts where required.

### Data-leak prevention

Seller response mapping removes fields that are not needed outside the seller scope. The access service resolves current seller/shop context and rejects a request when the seller does not own any matching item.

## 15. Event and Outbox Flow

### Purchase outbox

~~~text
Order transaction
   -> order + item snapshots
   -> purchase outbox PENDING
   -> database commit
   -> publisher reads pending outbox
   -> Kafka publish succeeds
   -> mark outbox PUBLISHED
~~~

The purchase outbox keeps the order database and the pending integration event in the same transaction. Kafka being unavailable should not make a committed order disappear; the outbox remains available for retry.

### Shipment consumer

~~~text
Shipping Service
   -> shipment.status.updated
   -> Order Kafka consumer
   -> locked order transition
   -> order/delivery events
~~~

### Event principles

- Use stable aggregate keys.
- Include event IDs and occurred-at timestamps.
- Do not publish payment/address secrets.
- Make consumers idempotent.
- Keep transport failure separate from order commit.
- Provide replay or reconciliation for delayed events.

## 16. API Surface

All public application routes use /api/v1. Health is /api/health.

### Customer order API

| Method | Route | Purpose |
| --- | --- | --- |
| POST | /api/v1/orders/quote | Calculate checkout shipping/total preview |
| POST | /api/v1/orders | Create an idempotent COD order |
| GET | /api/v1/orders | List owner orders with query/pagination |
| GET | /api/v1/orders/:orderId | Read an owned order |
| POST | /api/v1/orders/:orderId/cancel | Cancel an eligible owned order |
| POST | /api/v1/orders/:orderId/delivery-confirmation | Confirm delivery or report issue |
| POST | /api/v1/orders/:orderId/returns | Create a return request |
| GET | /api/v1/orders/:orderId/returns | List returns for an owned order |
| GET | /api/v1/orders/returns/:returnId | Read an owned return |
| POST | /api/v1/orders/returns/:returnId/cancellation | Cancel an eligible return |

### Seller order API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | /api/v1/seller/orders | List seller-scoped orders |
| GET | /api/v1/seller/orders/:orderId | Read seller-scoped order detail |
| GET | /api/v1/seller/orders/returns | List seller return work |
| POST | /api/v1/seller/orders/returns/:returnId/approve | Approve return |
| POST | /api/v1/seller/orders/returns/:returnId/reject | Reject return |
| POST | /api/v1/seller/orders/returns/:returnId/inspection | Record inspection |

### Internal contracts

| Method | Route family | Consumer purpose |
| --- | --- | --- |
| GET | /api/v1/internal/orders/:orderId/shipping-context | Shipping order/package context |
| POST | /api/v1/internal/orders/:orderId/seller-cancel | Trusted seller cancellation |
| POST | /api/v1/internal/orders/:returnId/return-received | Shipping return receipt |
| POST | /api/v1/internal/orders/:returnId/return-in-transit | Shipping return transition |
| GET | /api/v1/internal/orders/returns/:returnId/shipping-context | Return shipment context |
| POST | /api/v1/internal/orders/returns/:returnId/return-shipping-cost | Apply return shipping cost |
| GET | /api/v1/internal/orders/:orderId/owner-check | Ownership verification |
| GET | /api/v1/internal/orders/items/:orderItemId/review-context | Review eligibility/context |
| GET | /api/v1/internal/orders/:orderId/review-context | Order review context |
| GET | /api/v1/internal/orders/sales | Internal sales/reporting query |
| POST | /api/v1/internal/recommendation/purchases/replay | Replay completed purchases |

Internal routes require trusted service authentication and must not be exposed as public browser APIs.

## 17. Data Model

~~~text
Order
├── OrderItem[]
├── OrderStatusHistory[]
├── OrderReturnRequest[]
├── OrderDeliveryIssue[]
└── OrderPurchaseEventOutbox

OrderItem
├── product/variant/category snapshot
├── seller/shop/owner snapshot
├── price/quantity/line total
└── package data
~~~

### Order aggregate fields

The order entity stores order number, owner, legacy status, fulfillment status, delivery confirmation state, payment method/status, shipping address snapshot, shipping fee/breakdown, total amount, cancellation data, return window and idempotency fingerprint.

### Item snapshot fields

Order items store product ID, variant ID, category ID, seller shop/owner IDs, SKU, names, image URL, unit price, quantity, line total, package weight and package metadata.

### Delivery data

Delivery issue records store order/owner, affected item IDs, reason, evidence, note, related return ID and resolution metadata. Delivery confirmation fields on Order store method, deadline, delivered time and confirmation time.

### Return data

Return request records store order/shop/owner, selected item IDs, reason, description, evidence, review/inspection notes, seller actor, requested/reviewed/inspected timestamps and separated money values.

## 18. Consistency and Concurrency

### Idempotency

The unique owner/idempotency-key index protects duplicate checkout attempts. Request fingerprint comparison prevents a client from reusing a key with a materially different payload.

### Pessimistic locking

Delivery and shipment status synchronization locks the order row before applying a transition. This prevents two updates from reading the same old state and writing conflicting timelines.

### Reservation compensation

Inventory reservation is external to the Order database. If reservation succeeds but order commit fails, release must be attempted with the same reservation key. If another concurrent order owns the reservation, the compensation path must not release it.

### Outbox consistency

Order and purchase outbox data commit together. Kafka publication is retried separately. This provides at-least-once integration delivery while the database remains the order source of truth.

### Money arithmetic

Order/return money helpers convert decimal values to integer cents, apply explicit rounding and convert back to response strings. This avoids floating-point drift in shipping/refund calculations.

## 19. Project Structure

~~~text
src/
├── main.ts                              # HTTP bootstrap, validation, versioning, Swagger
├── app.module.ts                        # PostgreSQL, Kafka and feature composition
├── database/
│   ├── order/
│   │   ├── entities/                    # Order, item, status history
│   │   └── enums/                       # Order, fulfillment, payment states
│   ├── delivery/                        # Confirmation and issue entities/enums
│   ├── returns/                         # Return entity/enums
│   ├── integration/                     # Purchase outbox entity
│   └── migrations/                      # Versioned schema evolution
├── kafka/
│   ├── kafka-producer.service.ts        # Publish boundary
│   └── shipment-status.consumer.ts     # Shipment event consumer
└── modules/
    ├── order/
    │   ├── application/
    │   │   ├── clients/                 # Auth, Cart, Product, Seller, Shipping
    │   │   ├── errors/                  # Domain/application errors
    │   │   ├── services/
    │   │   │   ├── order/               # Checkout, list, seller access, events
    │   │   │   ├── delivery/            # Confirmation and automation
    │   │   │   └── returns/             # Return/refund workflow
    │   │   ├── types/                   # External and response contracts
    │   │   └── utils/                   # Money arithmetic
    │   ├── infrastructure/repositories/ # Order persistence
    │   └── presentation/
    │       ├── controllers/             # Customer, seller, internal routes
    │       └── dto/                     # Request validation schemas
    └── health/
~~~

The presentation layer should remain thin. Checkout, state transitions, compensation and ownership rules belong in application services, while repositories persist the result of those decisions.

## 20. Configuration Reference

### Runtime and database

| Variable | Purpose | Example |
| --- | --- | --- |
| PORT | HTTP listener | 3011 |
| NODE_ENV | Runtime mode and Swagger behavior | development |
| POSTGRES_HOST | PostgreSQL host | localhost |
| POSTGRES_PORT | PostgreSQL port | 5432 |
| POSTGRES_USER | Database user | bin_ecommerce |
| POSTGRES_PASSWORD | Database password | deployment secret |
| POSTGRES_DB | Order database | bin_ecommerce_order |

### Synchronous integrations

| Variable | Purpose | Example |
| --- | --- | --- |
| CART_SERVICE_URL | Active cart lookup/transition | http://localhost:3010 |
| AUTH_SERVICE_URL | User/address contract | http://localhost:3002 |
| PRODUCT_SERVICE_URL | Quote and inventory contract | http://localhost:3008 |
| SELLER_SERVICE_URL | Shop/ownership contract | http://localhost:3007 |
| INTERNAL_SERVICE_TOKEN | Trusted internal caller credential | deployment secret |

### Kafka

| Variable | Purpose | Example |
| --- | --- | --- |
| KAFKA_BROKERS | Broker list | localhost:29092 |
| KAFKA_CLIENT_ID | Producer/consumer client identity | order-service |

Use [.env.example](./.env.example) as the local variable template. Verify every service URL against the actual compose/container network before running checkout.

## 21. Development

### Commands

| Command | Purpose |
| --- | --- |
| npm run dev | Start Nest watch mode |
| npm run build | Build the service |
| npm run start | Run the built artifact |
| npm run type-check | TypeScript validation without emit |
| npm run lint | ESLint source validation |
| npm test | Run Jest tests |

### Recommended local gate

~~~powershell
npm run type-check
npm run lint
npm test -- --runInBand
npm run build
~~~

For checkout testing, use disposable customer, cart, product, inventory and order data. Keep Kafka topics and database separate from shared developer environments.

## 22. Testing Strategy

### Unit tests

Cover:

- Quote validation and server-side source selection.
- Idempotency key/fingerprint behavior.
- Reservation success and compensation failure.
- Checkout snapshot mapping.
- Cart close transition.
- Owner order list/detail isolation.
- Seller shop/item isolation.
- Legal and illegal order transitions.
- Delivery confirmation and issue reporting.
- Auto-completion deadline race.
- Return reason, evidence and active-return uniqueness.
- Refund/return shipping money arithmetic.
- Shipment event replay and forward-only synchronization.
- Outbox publish status behavior.

### Integration tests

Use PostgreSQL and service doubles to verify:

- Order/item/history/outbox transaction boundaries.
- Unique owner/idempotency index.
- Pessimistic locking on delivery/shipment updates.
- Return active-status unique index.
- Reservation release when persistence fails.
- Seller-scoped response mapping.
- Internal token and owner-check contracts.

### Acceptance flow

~~~text
Given an authenticated customer has an active cart
When the customer requests a quote
Then the service calculates from current server-side product/address/shipping data
When the customer creates an order with an idempotency key
Then one order, item snapshots, history and purchase outbox are committed
When the same request is retried
Then the existing order is returned
When shipping reports DELIVERED
Then fulfillment and delivery deadline state are updated safely
When the customer reports a return
Then a shop-scoped return request enters the correct workflow
~~~

### Failure scenarios to test

| Scenario | Assertion |
| --- | --- |
| Cart unavailable | No order is created |
| Product price changed after quote | Create path revalidates |
| Inventory reservation fails | No confirmed order |
| Order persistence fails after reservation | Release is attempted |
| Kafka unavailable after commit | Outbox remains pending/retryable |
| Duplicate shipment event | No backward/duplicate transition |
| Seller requests another shop's return | Access denied |
| Customer reuses idempotency key with new payload | Request rejected |

## 23. Security and Privacy

- Use Gateway-verified identity for customer operations.
- Resolve owner from trusted context, not body/query fields.
- Protect internal controllers with service authentication.
- Keep address snapshots and evidence limited to the necessary contract.
- Do not log full addresses, credentials, payment secrets or evidence URLs unnecessarily.
- Treat order number, customer identity and shipment references as sensitive operational data.
- Enforce seller shop scope before mapping response or applying return actions.
- Validate return evidence and media references through their owning contract.
- Avoid exposing internal reservation keys or service tokens.
- Audit order/return/delivery transitions with actor/source and timestamps.

The Gateway protects public admission, but Order Service must still enforce ownership and state transitions because internal callers and future deployment paths can bypass the browser edge.

## 24. Operational Notes

### Metrics and logs

Monitor:

- Checkout success/failure and quote latency.
- Product reservation success, release attempts and reservation leaks.
- Database transaction time, lock waits and connection pool saturation.
- Kafka outbox pending age, publish retries and shipment consumer lag.
- Delivery issue/return backlog and refund failure stages.
- Invalid seller/customer access attempts.

### Failure matrix

| Failure | Expected result |
| --- | --- |
| Cart service unavailable | Quote/create fails without fabricated cart |
| Product service unavailable | No unverified price/stock commit |
| Shipping quote unavailable | Quote/create fails or follows explicit fallback contract |
| PostgreSQL unavailable | No successful order mutation |
| Kafka unavailable after commit | Order stays committed; outbox retries |
| Shipment event malformed | Ignore/reject safely and log |
| Stale shipment event | Do not move order backward |
| Return refund fails | Keep REFUND_FAILED/auditable state |
| Auto-complete races with customer decision | Locked transaction preserves one valid outcome |

### Deployment checklist

1. Verify order database migrations and indexes.
2. Verify all downstream URLs and internal token wiring.
3. Confirm Product reservation and Cart checkout contracts are compatible.
4. Run quote and idempotent COD checkout in a disposable dataset.
5. Verify purchase outbox publication and retry behavior.
6. Publish a test shipment status and verify forward-only synchronization.
7. Exercise seller scope and customer owner checks.
8. Confirm Swagger is not exposed in production.
9. Monitor pending outbox and reservation/release metrics after rollout.

## 25. Documentation Findings

The following facts should be verified during deployment:

1. Order Service uses port 3011 in its environment template.
2. CART_SERVICE_URL currently points to localhost:3010 in the Order template, while the Cart Service has a different standalone default in its own configuration. Align the full-stack wiring before testing checkout.
3. The service currently supports COD as the declared payment method. Payment status fields do not prove that an external payment gateway is implemented.
4. Order and item snapshots are intentionally historical. They should not be used to answer current price or inventory questions.
5. Kafka producer failure is designed not to roll back a committed order; the purchase outbox is the recovery boundary.
6. Shipment consumer connection failure is non-fatal to HTTP startup, so deployment monitoring must detect a running service whose shipment synchronization is not connected.
7. Customer and seller routes share the Order module but have different ownership filters and response mappers.

This section documents current source/config behavior and integration risks. It does not silently change runtime configuration.

## 26. FAQ

### Why does Order Service store product and address snapshots?

To preserve what the customer accepted at checkout. Current Product/Auth data may change later, but the historical order must remain explainable.

### Is a quote a reservation?

No. A quote is a preview. Critical price, product and inventory checks happen again when creating the order.

### Why is idempotency scoped to the owner?

The same client key can be reused by different customers without colliding, while one customer cannot accidentally create two orders for one retryable checkout.

### What happens if Kafka is down after checkout?

The database order remains committed and the purchase outbox remains pending for retry. Kafka failure must not make a successful order disappear.

### Why does Order Service not read Product or Cart databases directly?

Each service owns its data and contract. Direct database reads bypass validation, versioning and ownership boundaries.

### Can a seller see the entire multi-seller order?

No. Seller views are filtered to the seller's owned shop/order items and use a seller-specific response mapping.

### Does delivery confirmation equal payment completion?

No. Fulfillment, delivery confirmation and COD payment status are separate state dimensions.

### Can a customer create multiple active returns for one shop?

The active-return uniqueness rule prevents multiple active return requests for the same order/shop combination.

### Can an order be deleted after cancellation?

It should not be deleted as a normal operation. Status history, snapshots and event references are required for audit and reconciliation.

## 27. Ownership

### Engineering

**Đào Ngọc Anh**

**Software Engineer**

[View portfolio](https://daongocanh.site)

Software Engineer responsible for the architecture, implementation, integration, and maintenance of this service.

### Architecture & API Design

**Đào Ngọc Anh**

Designed the checkout orchestration, order aggregate and snapshot boundary, idempotency/compensation strategy, delivery state machine, return/refund workflow, seller isolation, shipment synchronization and purchase outbox integration.
