// The page splits a rule at its top-level ANDs to show which part held.
import { expect, test } from "bun:test";
import { clauses, named } from "../src/graph.ts";

test("a rule splits at its top-level ANDs only", () => {
  expect(clauses("$exit_code = 0 AND $verdict = 'accepted' AND $accepted = true")).toEqual(["$exit_code = 0", "$verdict = 'accepted'", "$accepted = true"]);
  expect(clauses("$found = true and ($a AND $b)")).toEqual(["$found = true", "($a AND $b)"]);
  expect(clauses("$v = 'BRAND AND CO' AND $x > 1")).toEqual(["$v = 'BRAND AND CO'", "$x > 1"]);
  expect(clauses("all(r IN $results WHERE r.e < 1 AND r.f > 0)")).toEqual(["all(r IN $results WHERE r.e < 1 AND r.f > 0)"]);
  expect(clauses("$score >= 0 OR $error > 1e-8 AND $d > 0")).toEqual(["$score >= 0 OR $error > 1e-8 AND $d > 0"]);
  expect(clauses("$BAND > 1 AND $ANDROID")).toEqual(["$BAND > 1", "$ANDROID"]);
});

test("a rule names its measurements once each", () => {
  expect(named("$best.n < 300 AND $found AND $best.margin < 0")).toEqual(["best", "found"]);
});
