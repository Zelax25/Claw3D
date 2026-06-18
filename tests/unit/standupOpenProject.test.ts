import { describe, expect, it } from "vitest";

import {
  defaultStudioStandupPreference,
  normalizeStudioSettings,
  sanitizeStandupPreference,
} from "@/lib/studio/settings";
import { validateOpenProjectBaseUrl } from "@/lib/security/urlSafety";
import { isTaskBoardSource } from "@/features/office/tasks/types";

const GATEWAY_KEY = "ws://localhost:18789";

describe("standup OpenProject source", () => {
  it("defaults to a disabled, empty OpenProject config", () => {
    const preference = defaultStudioStandupPreference();
    expect(preference.openproject).toEqual({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      projectId: "",
      versionId: "",
    });
  });

  it("normalizes the OpenProject block and strips trailing slashes from baseUrl", () => {
    const normalized = normalizeStudioSettings({
      standup: {
        [GATEWAY_KEY]: {
          openproject: {
            enabled: true,
            baseUrl: "https://projects.example.com///",
            apiKey: "  secret-token  ",
            projectId: "9",
            versionId: "7",
          },
        },
      },
    });
    expect(normalized.standup?.[GATEWAY_KEY]?.openproject).toEqual({
      enabled: true,
      baseUrl: "https://projects.example.com",
      apiKey: "secret-token",
      projectId: "9",
      versionId: "7",
    });
  });

  it("redacts the OpenProject apiKey when sanitized for the client", () => {
    const preference = defaultStudioStandupPreference();
    preference.openproject = {
      enabled: true,
      baseUrl: "https://projects.example.com",
      apiKey: "secret-token",
      projectId: "9",
      versionId: "7",
    };
    const sanitized = sanitizeStandupPreference(preference);
    expect(sanitized.openproject.apiKey).toBe("");
    expect(sanitized.openproject.apiKeyConfigured).toBe(true);
    expect(sanitized.openproject.baseUrl).toBe("https://projects.example.com");
  });

  describe("validateOpenProjectBaseUrl", () => {
    it("accepts a public https host and returns its origin", () => {
      expect(validateOpenProjectBaseUrl("https://projects.example.com/")).toBe(
        "https://projects.example.com"
      );
    });

    it("rejects http", () => {
      expect(() => validateOpenProjectBaseUrl("http://projects.example.com")).toThrow(
        /https/
      );
    });

    it("rejects loopback and private-network hosts", () => {
      expect(() => validateOpenProjectBaseUrl("https://localhost")).toThrow(
        /loopback or private/
      );
      expect(() => validateOpenProjectBaseUrl("https://10.10.0.11")).toThrow(
        /loopback or private/
      );
    });

    it("rejects embedded credentials and query strings", () => {
      expect(() =>
        validateOpenProjectBaseUrl("https://user:pass@projects.example.com")
      ).toThrow(/credentials/);
      expect(() =>
        validateOpenProjectBaseUrl("https://projects.example.com/?a=1")
      ).toThrow(/query string or hash/);
    });
  });

  it("accepts openproject as a task-board source for the sprint push", () => {
    expect(isTaskBoardSource("openproject")).toBe(true);
  });
});
