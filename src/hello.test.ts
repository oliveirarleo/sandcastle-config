import assert from "assert";
import { greet } from "./hello";

assert.strictEqual(greet("world"), "Hello, world!");
assert.strictEqual(greet("Alice"), "Hello, Alice!");
console.log("All tests passed!");
