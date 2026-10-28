import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser } from "./helpers";
import { registerConnection, registerDisconnection, __resetPresenceTrackerForTests } from "../src/realtime/presence-tracker";

// A real (short) grace period instead of the production value — see the
// comment on registerDisconnection's graceMs param for why fake timers
// don't mix well with the real Postgres write this triggers. WAIT is
// several multiples of GRACE_MS so a real, if occasionally slow, CI
// machine still has comfortable margin before the assertion runs.
const GRACE_MS = 40;
const WAIT_MS = 250;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPresence(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.presence;
}

describe("presence tracking — reflects whether the browser is actually still connected", () => {
  beforeEach(async () => {
    await resetDatabase();
    __resetPresenceTrackerForTests();
  });

  afterAll(async () => {
    __resetPresenceTrackerForTests();
    await prisma.$disconnect();
  });

  it("marks a user ONLINE the moment their first socket connects", async () => {
    const user = await createTestUser({ email: "ana@test.dev", role: "AGENT", presence: "OFFLINE" });
    await registerConnection(user.id, "socket-1");
    expect(await getPresence(user.id)).toBe("ONLINE");
  });

  it("only flips to OFFLINE after the grace period once every socket has disconnected — never instantly", async () => {
    const user = await createTestUser({ email: "bruno@test.dev", role: "AGENT", presence: "OFFLINE" });
    await registerConnection(user.id, "socket-1");

    registerDisconnection(user.id, "socket-1", GRACE_MS);
    expect(await getPresence(user.id)).toBe("ONLINE"); // still within the grace window

    await wait(WAIT_MS);
    expect(await getPresence(user.id)).toBe("OFFLINE");
  });

  it("stays ONLINE across the routine disconnect+reconnect the app does on every access-token refresh (~15min)", async () => {
    const user = await createTestUser({ email: "carla@test.dev", role: "AGENT", presence: "OFFLINE" });
    await registerConnection(user.id, "socket-1");

    // AppLayout.tsx's own reconnect-on-new-token pattern: disconnect the old
    // socket, connect a new one, almost immediately — well inside the grace window.
    registerDisconnection(user.id, "socket-1", GRACE_MS);
    await registerConnection(user.id, "socket-2");

    // The stale offline timer from the first disconnect must not still fire later.
    await wait(WAIT_MS);
    expect(await getPresence(user.id)).toBe("ONLINE");
  });

  it("stays ONLINE while at least one of several tabs/devices is still connected", async () => {
    const user = await createTestUser({ email: "duda@test.dev", role: "AGENT", presence: "OFFLINE" });
    await registerConnection(user.id, "tab-1");
    await registerConnection(user.id, "tab-2");

    registerDisconnection(user.id, "tab-1", GRACE_MS); // closed one of two tabs
    await wait(WAIT_MS);
    expect(await getPresence(user.id)).toBe("ONLINE"); // tab-2 is still open

    registerDisconnection(user.id, "tab-2", GRACE_MS); // now closes the last one
    await wait(WAIT_MS);
    expect(await getPresence(user.id)).toBe("OFFLINE");
  });

  it("a genuine reconnect right before the grace period elapses cancels the pending offline write instead of racing it", async () => {
    const user = await createTestUser({ email: "eva@test.dev", role: "AGENT", presence: "OFFLINE" });
    await registerConnection(user.id, "socket-1");
    registerDisconnection(user.id, "socket-1", GRACE_MS);

    // Reconnects partway through the grace window.
    await wait(GRACE_MS / 2);
    await registerConnection(user.id, "socket-2");
    await wait(WAIT_MS);

    expect(await getPresence(user.id)).toBe("ONLINE");
  });
});
