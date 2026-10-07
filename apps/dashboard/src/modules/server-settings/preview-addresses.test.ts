import { expect, it } from "vitest";
import { studentAddressChoices, studentOrigin } from "./preview-addresses.js";

it.each([
  "",
  "broken",
  "ftp://school.test",
  "https://school'quote.test",
  "https://user@school.test",
  "https://:password@school.test",
  "http://localhost:18787",
  "https://LOCALHOST.",
  "http://school.localhost",
  "http://school.localhost.",
  "http://127.99.0.2",
  "http://2130706433",
  "http://[::1]",
  "http://[0:0:0:0:0:0:0:1]",
  "http://0.0.0.0",
  "http://[::]",
  "http://[::ffff:127.1.2.3]",
  "http://[::ffff:0.0.0.0]",
])("never offers an unusable or unsafe address: %s", (value) => {
  expect(studentOrigin(value)).toBeNull();
});

it.each([
  ["http://10.0.4.25:18787/dashboard/", "http://10.0.4.25:18787"],
  ["https://School.test:443/path?q=value", "https://school.test"],
  ["http://school.test:80", "http://school.test"],
  ["https://localhost.example", "https://localhost.example"],
  ["http://127.school.test", "http://127.school.test"],
  ["http://127.0.0.1.school.test", "http://127.0.0.1.school.test"],
  ["http://127.school-a1", "http://127.school-a1"],
  ["http://[2001:db8::1]:18787", "http://[2001:db8::1]:18787"],
  ["http://[::ffff:192.168.1.20]", "http://[::ffff:c0a8:114]"],
  ["http://[::ffff:7f00:1:3]", "http://[::ffff:7f00:1:3]"],
])("accepts a routable HTTP or HTTPS origin: %s", (value, origin) => {
  expect(studentOrigin(value)).toBe(origin);
});

it("prefers the opened remote address and deduplicates the server choices", () => {
  expect(
    studentAddressChoices(
      ["http://10.0.4.25:18787", "https://school.test/"],
      "https://school.test",
    ),
  ).toEqual({
    choices: ["https://school.test", "http://10.0.4.25:18787"],
    initial: "https://school.test",
  });
});

it("selects a single LAN address from localhost and requires a choice when networks differ", () => {
  const local = "http://127.0.0.1:18787";
  const lan = "http://10.0.4.25:18787";
  const second = "http://192.168.1.20:18787";
  expect(studentAddressChoices([local, lan, lan], local)).toEqual({ choices: [lan], initial: lan });
  expect(studentAddressChoices([lan, second], local)).toEqual({
    choices: [lan, second],
    initial: "",
  });
  expect(studentAddressChoices([local], local)).toEqual({ choices: [], initial: "" });
});
