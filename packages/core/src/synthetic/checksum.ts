const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
const BIZNUM_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

export function syntheticRrn(index: number): string {
  const seq = String(((index - 1) % 99999) + 1).padStart(5, "0");
  const head = `9001011${seq}`;
  const digits = head.split("").map((c) => Number(c));
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += digits[i]! * RRN_WEIGHTS[i]!;
  const check = (11 - (sum % 11)) % 10;
  return `900101-1${seq}${check}`;
}

export function syntheticBizNum(index: number): string {
  const seq = String(((index - 1) % 9999) + 1).padStart(4, "0");
  const head = `10000${seq}`;
  const digits = head.split("").map((c) => Number(c));
  let partial = 0;
  for (let i = 0; i < 9; i += 1) partial += digits[i]! * BIZNUM_WEIGHTS[i]!;
  const tail = Math.floor((digits[8]! * 5) / 10);
  const sum = partial + tail;
  const check = (10 - (sum % 10)) % 10;
  return `100-00-${seq}${check}`;
}

export function syntheticCard(index: number): string {
  const prefix = "424242424242";
  const seq = String(((index - 1) % 999) + 1).padStart(3, "0");
  const partial = prefix + seq;
  const digits = partial.split("").map((c) => Number(c));
  let total = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    let d = reversed[i]!;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  const check = (10 - (total % 10)) % 10;
  return `4242 4242 4242 ${seq}${check}`;
}
