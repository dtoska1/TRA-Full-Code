const fs = require('fs');
const path = require('path');
let pdf;
try { pdf = require('pdf-parse/lib/pdf-parse.js'); }
catch (e) { pdf = require('pdf-parse'); }
const files = {
  "DURRES_Ind5_RaportiDegjesave":       "46a856f6-240a-4232-9faa-490c932fc799.pdf",
  "VLORE_Ind3_ProjektVendimTaksat":     "2e5e11a7-cd5c-47e5-9bce-d6990ed69084.pdf",
  "POGRADEC_Ind1_PlaniKonsultimeve2022":"6ef8b754-49b3-4059-94c9-e36a1ac8cc91.pdf",
  "DURRES_Ind3_RelacionKlubiTeuta":     "91229d0d-2d74-4d42-9305-6ec598aa39f0.pdf",
  "POGRADEC_Ind3_PvSherbimeveTaksi":    "607c9d66-f3e1-44da-bd3d-d0568f2645c4.pdf",
  "SHKODER_Ind3_PvArsimit_alsoN22":     "16f8eff4-bc22-4250-a677-4e19fa5c1b32.pdf",
  "SHKODER_N21_a":                      "36eb2f77-819f-4998-a188-0f9bd2637e37.pdf",
  "SHKODER_N22_b":                      "12a41bd0-df7b-4980-9ead-bf15d4dfc8a4.pdf",
};
(async () => {
  for (const [label, fn] of Object.entries(files)) {
    const p = path.join("uploads", fn);
    try {
      const d = await pdf(fs.readFileSync(p));
      const t = (d.text || "").replace(/\n{3,}/g, "\n\n").trim();
      console.log("\n===== " + label + " (" + fn + ") pages=" + d.numpages + " chars=" + t.length + " =====");
      console.log(t.length ? t.slice(0, 3500) : "[[EMPTY - likely scanned image, route to Chrome]]");
    } catch (e) { console.log("\n===== " + label + " ERROR: " + e.message + " ====="); }
  }
})();
