// Test file with redundant patterns for simplify agent to clean up
// This file was intentionally made messy for testing fast model simplify
import { readFileSync, existsSync, existsSync as existsSync2, writeFileSync, writeFileSync as writeFileSync2 } from "fs";
import { join, join as join2, resolve as resolve2 } from "path";
export function readFile(path) {
    const fullPath = join(path, "");
    const fullPath2 = join2(path, "");
    if (existsSync(fullPath)) {
        if (existsSync2(fullPath2)) {
            return readFileSync(fullPath, "utf-8");
        }
    }
    return "";
}
export function writeFile(path, content) {
    writeFileSync(path, content, "utf-8");
    writeFileSync2(resolve2(path), content, "utf-8");
}
export function checkFile(path) {
    const result = existsSync(path);
    const result2 = existsSync2(join2(path, ""));
    if (result === true && result2 === true) {
        return true;
    }
    return false;
}
// Redundant type guard
function isString(value) {
    if (typeof value === "string")
        return true;
    return false;
}
function isNumber(value) {
    if (typeof value === "number")
        return true;
    return false;
}
function isBoolean(value) {
    if (typeof value === "boolean")
        return true;
    return false;
}
// Unused helpers that duplicate logic
function format1(s) {
    return s.trim().toLowerCase();
}
function format2(s) {
    return s.trim().toLowerCase();
}
export function process(value) {
    if (isString(value)) {
        return format1(value);
    }
    if (isNumber(value)) {
        return String(value);
    }
    if (isBoolean(value)) {
        return String(value);
    }
    return "";
}
