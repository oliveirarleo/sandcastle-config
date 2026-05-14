import assert from "assert";
import { greet } from "./hello";

assert.strictEqual(greet("world"), "Hello, world!", 'greet("world") should return "Hello, world!"');
assert.strictEqual(greet("Alice"), "Hello, Alice!", 'greet("Alice") should return "Hello, Alice!"');
console.log("All tests passed!");
