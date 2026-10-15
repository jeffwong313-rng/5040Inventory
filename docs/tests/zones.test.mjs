// Run with:  node --test docs/tests/zones.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseCountTeams, parseTeamSpecific, teamList, findTeam,
  parseAssignment, resolveSpecs, resolveMfrs, colorFamily,
} from "../zones.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => readFileSync(join(here, "fixtures", f), "utf8");
const short = (text) => parseAssignment(text).map((s) => [s.tab, s.color, s.kind, s.ids && s.ids.join("")]);

test("parses the three rounds of Count Teams", () => {
  const phases = parseCountTeams(fx("count_teams.csv"));
  assert.deepEqual(phases.map((p) => p.name), ["PreCounts", "First Count", "Variance 1"]);
  assert.equal(findTeam(phases[0], "Team2").section, "WH1-PURPLE E-H");
  assert.equal(findTeam(phases[1], "team3").zone.startsWith("WH1-RED-B"), true);
  assert.deepEqual(findTeam(phases[2], "Team1").mfr, ["TESLA", "QCELL"]);
  assert.deepEqual(phases[1].zonesLeft, ["WH1-GREEN-D", "WH1-GREEN-E", "WH1-GREEN-L", "WH1-GREEN-M", "WH1-GREEN-N"]);
  const helpers = phases[0].teams.filter((t) => t.helper);
  assert.equal(helpers.length, 1);
  assert.deepEqual(helpers[0].members, ["David from Ironridge", "Yohan from Pegasus", "Grace"]);
});

test("Team Specific roles and team list", () => {
  const spec = parseTeamSpecific(fx("team_specific.csv"));
  assert.equal(spec.team1.counter, "Archie Cole");
  assert.equal(spec.team1.recorder, "Frank Gallagher");
  const teams = teamList(parseCountTeams(fx("count_teams.csv")), spec);
  assert.equal(teams[0], "Team1");
  assert.equal(teams[teams.length - 1], "Team12");
  assert.ok(!teams.includes("Precounts"));
});

test("assignment text shapes used in the sheet", () => {
  assert.deepEqual(short("WH1-PURPLE E-H"), [["WH1", "PURPLE", null, "EFGH"]]);
  assert.deepEqual(short("WH2, WH3, then float for whoever needs help"), [["WH2", null, null, null], ["WH3", null, null, null]]);
  assert.deepEqual(short("WH1-GRAY, WH1-BLUE-A, BLUE-B"), [["WH1", "GRAY", null, null], ["WH1", "BLUE", null, "A"], ["WH1", "BLUE", null, "B"]]);
  assert.deepEqual(short("WH1-PURPLE-E / F"), [["WH1", "PURPLE", null, "E"], ["WH1", "PURPLE", null, "F"]]);
  assert.deepEqual(short("WH1-BLUE-H WH1-BLUE-I"), [["WH1", "BLUE", null, "H"], ["WH1", "BLUE", null, "I"]]);
  assert.deepEqual(short("Yard-"), [["YARD", null, null, null]]);
  assert.deepEqual(short("YARD-FENCE-03"), [["YARD", null, "FENCE", "3"]]);
  assert.deepEqual(short("WH1-YELLOW-3C"), [["WH1", "YELLOW", null, "3C"]]);
});

test("colour families", () => {
  assert.equal(colorFamily("#9900ff"), "PURPLE");
  assert.equal(colorFamily("#6d9eeb"), "BLUE");
  assert.equal(colorFamily("#d9ead3"), "GREEN");
  assert.equal(colorFamily("#ff9900"), "ORANGE");
  assert.equal(colorFamily("#ff00ff"), "MAGENTA");
  assert.equal(colorFamily("#cccccc"), "GRAY");
});

const mapPath = join(here, "..", "data", "map.json");
test("zones land on the generated map", { skip: !existsSync(mapPath) }, () => {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const texts = (r, key) => [...(r.byTab[key] || [])].map((i) => map.tabs.find((t) => t.key === key).cells[i][5]);
  const purple = resolveSpecs(parseAssignment("WH1-PURPLE E-H"), map);
  assert.ok(texts(purple, "WH1").includes("LUNAR / SIGEN / SMA / QCELL"));
  assert.ok(!texts(purple, "WH1").includes("WIRE / FLEX")); // that row is D
  const yard = resolveSpecs(parseAssignment("YARD"), map);
  assert.ok(yard.whole.has("YARD"));
  const mfr = resolveMfrs(["TESLA"], map);
  assert.ok(Object.keys(mfr.byTab).length > 0);
});
