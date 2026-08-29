// File test cho utility tiền tệ của Order Service, tập trung vào độ chính xác khi cộng subtotal.

import { fromCents, toCents } from "./order-money.util";

describe("order-money.util", () => {
  // Chuyển tiền decimal sang cents bằng BigInt mà không bị sai số floating point.
  it("should convert decimal money to cents exactly", () => {
    // Arrange
    const value = "22000.50";

    // Act
    const result = toCents(value);

    // Assert
    expect(result).toBe(2200050n);
  });

  // Định dạng cents thành hai chữ số thập phân ổn định cho database và API response.
  it("should format cents with two decimal places", () => {
    // Arrange
    const value = 4400000n;

    // Act
    const result = fromCents(value);

    // Assert
    expect(result).toBe("44000.00");
  });

  // Từ chối giá trị tiền không hợp lệ thay vì âm thầm tính sai tổng đơn.
  it("should reject malformed monetary values", () => {
    // Arrange
    const value = "22.999";

    // Act & Assert
    expect(() => toCents(value)).toThrow("Invalid monetary value");
  });
});
