import { describe, expect, it, vi } from "vitest";
import { TelemetryPreviewResponseSchema } from "@marea/protocol";
import { previewFixture, previewHttpRequest, origin } from "../../telemetry/preview.fixture.js";
import { withTelemetryPreview } from "./telemetry-composition.js";

describe("production telemetry composition", () => {
  it("adds disabled preview using current SQLite membership and preserves product dispatch", async () => {
    const f = previewFixture();
    try {
      const product = { fetch: vi.fn(() => new Response("existing product")) };
      const app = withTelemetryPreview(product, {
        database: f.database,
        identity: f.identity,
        allowedHosts: ["teacher.test"],
        allowedOrigins: [origin],
      });
      const cookie = await f.cookie();
      const result = await app.fetch(previewHttpRequest(cookie));
      expect(result.status).toBe(200);
      expect(TelemetryPreviewResponseSchema.parse(await result.json())).toMatchObject({
        enabled: false,
        destinationCount: 0,
      });
      expect(product.fetch).not.toHaveBeenCalled();
      const original = new Request("https://teacher.test/v1/runs/open");
      expect(await (await app.fetch(original)).text()).toBe("existing product");
      expect(product.fetch).toHaveBeenCalledExactlyOnceWith(original);
      f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
      expect((await app.fetch(previewHttpRequest(cookie))).status).toBe(403);
    } finally {
      f.database.close();
    }
  });
});
