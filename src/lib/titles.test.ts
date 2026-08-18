import { describe, expect, it } from "vitest";
import { hasPartMarker, isAccessibilityVersion, stripBroadcastAnnotations } from "./titles";

describe("isAccessibilityVersion", () => {
  it("recognises the annotations the broadcasters actually use", () => {
    const cases = [
      "Folge 2: Lügen (S01/E02) (Audiodeskription)",
      "Polizeiruf 110 (Gebärdensprache)",
      "Tatort (DGS)",
      "Die Sendung (Hörfassung)",
      "Der Film (Hörfilm)",
      "Nachrichten (klare Sprache)",
      "Magazin (Leichte Sprache)",
    ];
    for (const title of cases) {
      expect(isAccessibilityVersion(title), title).toBe(true);
    }
  });

  it("tolerates ASCII spellings of the umlauts", () => {
    expect(isAccessibilityVersion("Krimi (Gebaerdensprache)")).toBe(true);
    expect(isAccessibilityVersion("Doku (Hoerfassung)")).toBe(true);
  });

  it("leaves language variants alone -- those are legitimate audio tracks", () => {
    expect(isAccessibilityVersion("Lost Country (Originalversion mit Untertitel)")).toBe(false);
    expect(isAccessibilityVersion("Le Havre (OmU)")).toBe(false);
    expect(isAccessibilityVersion("Der Film (Originalfassung)")).toBe(false);
  });

  it("does not fire on a plain episode title", () => {
    expect(isAccessibilityVersion("Folge 1: Schweigen  (S01/E01)")).toBe(false);
    expect(isAccessibilityVersion("Die Augenzeugen")).toBe(false);
  });

  it("only matches inside parentheses, not a mention in prose", () => {
    expect(isAccessibilityVersion("Ein Beitrag über Audiodeskription im Fernsehen")).toBe(false);
  });
});

describe("stripBroadcastAnnotations (unchanged behaviour)", () => {
  it("still removes the annotation from a title", () => {
    expect(stripBroadcastAnnotations("Tatort (Audiodeskription)")).toBe("Tatort");
  });
});

describe("hasPartMarker (unchanged behaviour)", () => {
  it("still detects serialised parts", () => {
    expect(hasPartMarker("Fabian (1/4)")).toBe(true);
    expect(hasPartMarker("8 1/2")).toBe(false);
  });
});
