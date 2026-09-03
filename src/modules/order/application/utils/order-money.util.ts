// File này tính tiền bằng số nguyên cent để tránh sai số floating point khi cộng nhiều item.

// Chuyển số tiền decimal tối đa hai chữ số thập phân thành cents trước khi tính toán.
export function toCents(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Invalid monetary value");
  }
  const [whole = "", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

// Trả decimal chuẩn hai chữ số để PostgreSQL và frontend nhận cùng một representation.
export function fromCents(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
