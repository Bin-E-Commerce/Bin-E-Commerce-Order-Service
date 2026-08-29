<div align="center">

<img src="https://raw.githubusercontent.com/Bin-E-Commerce/Bin-E-Commerce-UI-Web/main/public/images/logo/logo_icon.png" alt="Bin E-Commerce" width="112" />

# Bin E-Commerce — Order Service

### Turning a verified cart into an auditable order

`Order Service` is the transaction boundary for checkout, order snapshots, order state, and the first reliable hand-off from shopping to fulfillment.

![Status](https://img.shields.io/badge/status-Phase%201%20scaffold-111827?style=flat-square)
![Runtime](https://img.shields.io/badge/runtime-Node.js%2020%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![Framework](https://img.shields.io/badge/framework-NestJS-E0234E?style=flat-square&logo=nestjs&logoColor=white)
![Database](https://img.shields.io/badge/database-PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)

[Architecture](#architecture) · [Phase 1](#phase-1--checkout--cod) · [API](#public-api) · [Roadmap](#roadmap)

</div>

---

> [!NOTE]
> This repository currently contains the service README only. The implementation is intentionally introduced after the contract and ownership boundaries are reviewed and committed.

## The problem

A shopping cart is mutable. An order must not be.

Between the moment a buyer clicks **Thanh toán** and the moment a purchase is accepted, prices can change, stock can be claimed by another buyer, and a saved address can be edited. If checkout trusts the browser or stores only references to mutable data, the platform cannot reliably answer a simple question later:

> What exactly did this buyer agree to purchase, at which price, and where was it supposed to be delivered?

Order Service solves that boundary by re-reading authoritative data, reserving stock atomically, and persisting immutable order snapshots before confirming a COD order.

## What this service owns

| Responsibility | Owner | Boundary |
| --- | --- | --- |
| Order aggregate and lifecycle | Order Service | The source of truth for orders |
| Order item snapshots | Order Service | Product name, SKU, variant, image, price and quantity at checkout |
| Shipping address snapshot | Order Service | A copy captured at order creation; never a live reference |
| Cart contents | Cart Service | Read during checkout; cleared only after confirmation |
| Product, variant and stock | Product Service | Revalidated and reserved through an internal API |
| User and saved addresses | Auth Service | Ownership is verified before snapshotting |
| Shop ownership | Product/Seller domains | Order Service stores `sellerShopId` as a reference, not a foreign key |

Order Service does not query another service's database. Cross-service data is accessed through explicit HTTP contracts, while the order database remains independently deployable.

## Architecture

```text
                          Browser
                             │
                             │ POST /api/v1/orders
                             ▼
                       API Gateway :3000
                    JWT + permission context
                             │
                             ▼
                    Order Service :3004
                 PostgreSQL — order ownership
                    │         │          │
           read cart│         │address  │quote + reserve
                    ▼         ▼          ▼
              Cart Service  Auth Service  Product Service
                 :3003        :3001           :3008
                    │                         │
                    │                         └─ atomic inventory transaction
                    └─ clear after CONFIRMED
```

### Why Order is a separate service

An order is a commerce aggregate, not a seller profile. One order may contain items from multiple shops, while the same order must also support customer history, payment, shipping, cancellation, support, and administration.

Seller-facing order management will consume this service with shop-scoped queries later. It will not move the order source of truth into `seller-service`.

## Phase 1 — Checkout + COD

Phase 1 delivers one complete, testable vertical slice for both `CUSTOMER` and `SELLER` accounts:

```text
Authenticated user
  → review active cart
  → select or create a shipping address
  → choose COD
  → server revalidates cart, price and stock
  → Product Service reserves stock atomically
  → Order Service stores snapshots
  → order becomes CONFIRMED
  → Cart Service clears the active cart
```

### Phase 1 includes

- PostgreSQL persistence for `orders`, `order_items` and `order_status_history`.
- `POST /api/v1/orders` through the existing API Gateway.
- Server-side subtotal and total calculation.
- Current product and variant validation.
- Atomic inventory reservation inside Product Service.
- Shipping address ownership verification through Auth Service.
- Idempotent checkout using `Idempotency-Key`.
- Cart cleanup after successful confirmation.
- Checkout UI with address selection, inline address creation and COD confirmation.
- Customer and Seller permission grants using `order.create` with `OWN` scope.

### Phase 1 deliberately excludes

- Stripe, payment intents and payment webhooks.
- Voucher and promotion reservation.
- Shipping carrier integration.
- Cancellation, refund and return workflows.
- Seller fulfillment screens and Admin order operations.
- Kafka events, Camunda orchestration and recommendation events.

Keeping these concerns outside the first slice makes the core transaction observable and testable before asynchronous workflows are added.

## Order lifecycle

```text
                         stock reservation succeeds
                  ┌──────────────────────────────────┐
                  │                                  ▼
              ┌─────────┐                       ┌───────────┐
              │ PENDING │ ────────────────────▶ │ CONFIRMED │
              └────┬────┘                        └───────────┘
                   │
                   │ validation, product or stock failure
                   ▼
              ┌────────┐
              │ FAILED │
              └────────┘
```

`CONFIRMED` means that the COD order has passed validation and the requested inventory has been reserved. It does not mean that shipment or delivery has started.

The later fulfillment lifecycle will extend this state machine with payment, shipping, delivery and cancellation states without changing the historical snapshots of an existing order.

## Public API

### Create a COD order

```http
POST /api/v1/orders
Authorization: Bearer <access-token>
Idempotency-Key: 6b9f1f4a-5b7b-4b4c-9ad3-0a7e1ec09c41
Content-Type: application/json
```

```json
{
  "shippingAddressId": "address-uuid",
  "paymentMethod": "COD",
  "note": "Giao giờ hành chính"
}
```

The request intentionally contains no item price, subtotal or product snapshot. Order Service obtains the active cart and asks Product Service for the current, authoritative checkout data.

Successful response:

```json
{
  "id": "order-uuid",
  "status": "CONFIRMED",
  "paymentMethod": "COD",
  "subtotal": "104000.00",
  "shippingFee": "0.00",
  "totalAmount": "104000.00",
  "shippingAddress": {
    "fullName": "Nguyễn Văn A",
    "phone": "0901234567",
    "province": "TP. Hồ Chí Minh",
    "district": "Quận 1",
    "ward": "Phường Bến Nghé",
    "street": "123 Đường Lê Lợi"
  },
  "items": [
    {
      "productId": "product-uuid",
      "variantId": "variant-uuid",
      "sku": "SKU-001",
      "productName": "Áo thể thao",
      "variantName": "Đen - XL",
      "unitPrice": "22000.00",
      "quantity": 2,
      "lineTotal": "44000.00"
    }
  ],
  "warnings": [],
  "createdAt": "2026-08-29T00:00:00.000Z"
}
```

### Error behavior

| Status | Meaning |
| --- | --- |
| `400` | Invalid address ID, payment method or note |
| `401` | Missing authenticated user context |
| `403` | User does not have `order.create` |
| `404` | Address or active cart cannot be found |
| `409` | Stock conflict or an incompatible idempotency request |
| `422` | Empty cart, inactive product, inactive variant or external product |
| `503` | Cart, Auth or Product Service is unavailable |

Failed validation must never produce a `CONFIRMED` order. If inventory was reserved before a later persistence failure, the reservation is released through the Product Service compensation endpoint.

## Consistency rules

### Server-side truth

The browser is allowed to select an address and request COD. It is not trusted for price, stock, product state or final totals.

### Immutable snapshots

At creation time, the order stores:

- product and variant identity;
- seller shop reference;
- product name, variant name, SKU and image;
- current unit price and quantity;
- complete shipping address;
- calculated subtotal, shipping fee and total.

Changes in Product Service or Auth Service must not rewrite historical order data.

### Idempotent retries

The Gateway forwards `Idempotency-Key`. Order Service stores it per user and applies this contract:

- same user + same key + same request: return the existing order;
- same user + same key + different request: return a conflict;
- a retried pending operation resumes safely;
- a confirmed order is never duplicated by a double click or network retry.

### Inventory reservation

Product Service remains the inventory owner. It locks inventory rows inside a database transaction, verifies available quantity, updates available/reserved quantities, and records the reservation key. Retrying the same reservation key must not decrement stock twice.

## Data model overview

```text
orders
  ├── order_items
  └── order_status_history
```

The order database contains no foreign keys to Product Service or Auth Service. Cross-service IDs are opaque references. `order_items.order_id` is the only required relationship and is deleted with the order record if an administrative data repair ever requires it.

The database will use PostgreSQL migrations and will not rely on production `synchronize` behavior.

## Security boundary

| Caller | Route | Permission |
| --- | --- | --- |
| Customer | `POST /api/v1/orders` | `order.create` / `OWN` |
| Seller | `POST /api/v1/orders` | `order.create` / `OWN` |
| Guest | `POST /api/v1/orders` | Denied; must authenticate first |
| Internal services | Reservation/address/cart APIs | `x-internal-service-token` |

The Gateway authenticates the public request and forwards the user context. Internal service calls use direct service URLs and a shared internal token; they never route back through the Gateway.

## Local development

The runtime scaffold is intentionally not available yet. After Phase 1 implementation, the service will follow the repository's NestJS conventions:

```bash
cd services/order-service
npm install
npm run start:dev
```

Expected local configuration:

```env
PORT=3004
NODE_ENV=development
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=bin_ecommerce
POSTGRES_PASSWORD=changeme_postgres
POSTGRES_DB=bin_ecommerce_order
CART_SERVICE_URL=http://localhost:3003
AUTH_SERVICE_URL=http://localhost:3001
PRODUCT_SERVICE_URL=http://localhost:3008
INTERNAL_SERVICE_TOKEN=replace-with-local-secret
```

The service will be enabled in the application Docker Compose only when its implementation, healthcheck and migration path are ready.

## Verification plan

Phase 1 acceptance is based on behavior, not on a successful HTTP status alone:

1. A Customer can place a COD order from a non-empty cart.
2. A Seller can place a COD order using the same flow.
3. The saved address belongs to the authenticated user.
4. The order contains current Product Service snapshots, not browser values.
5. Concurrent checkout requests cannot reserve more stock than available.
6. Retrying the same idempotency key returns the same order.
7. Confirmed orders clear the correct user's active cart.
8. A failed reservation leaves no confirmed order and no permanently reduced stock.
9. A Guest is redirected to login by the frontend and receives `401` at the API boundary.

## Roadmap

| Phase | Capability | Result |
| --- | --- | --- |
| **1** | Checkout + COD | Confirmed order with safe stock reservation |
| **2** | Customer order history | List and detail of the user's own orders |
| **3** | Seller order view | Shop-scoped order items for fulfillment |
| **4** | Cancellation and inventory release | Safe pre-shipment cancellation flow |
| **5** | Stripe payment | Payment intent, webhook and failure compensation |
| **6** | Shipping lifecycle | Shipment creation, tracking and delivery states |
| **7** | Events and notifications | Durable order events and customer notifications |
| **8** | Recommendation feedback | Purchase and order signals for the recommendation pipeline |

Each phase adds a bounded capability to the existing order aggregate. It does not move ownership into Cart, Product or Seller Service.

## Related documentation

- [Order domain specification](../../docs/domain/04-order.md)
- [Business overview](../../docs/domain/00-business-overview.md)
- [Auth and user domain](../../docs/domain/01-auth-user.md)
- [Cart Service](../cart-service/README.md)

## Contribution notes

- Keep business rules inside Order Service or the service that owns the data.
- Never trust client totals or cart snapshots as checkout truth.
- Never query another service's database directly.
- Add migrations for schema changes; do not depend on production synchronization.
- Add unit and integration tests for every state transition and external failure path.
- Preserve idempotency and ownership checks when extending the API.

## License

This service is part of the Bin E-Commerce project. Refer to the repository root for project-wide licensing and contribution terms.
