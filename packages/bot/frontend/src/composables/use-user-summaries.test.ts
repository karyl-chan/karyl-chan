import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick, computed, defineComponent } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../api/discord", () => ({
  fetchUserSummaries: vi.fn(),
}));

import { fetchUserSummaries } from "../api/discord";
import { useUserSummaries } from "./use-user-summaries";
import { useUserSummaryStore } from "../modules/discord-chat/stores/userSummaryStore";

const mockFetch = vi.mocked(fetchUserSummaries);

interface AdminLike {
  userId: string;
  role: string;
}

const RealisticComponent = defineComponent({
  template:
    '<div><span v-for="a in admins" :key="a.userId" class="name">{{ display(a.userId) }}</span></div>',
  props: {
    admins: { type: Array as () => AdminLike[], required: true },
  },
  setup(props) {
    const store = useUserSummaryStore();
    const userIds = computed(() => props.admins.map((a) => a.userId));
    useUserSummaries(userIds);
    function display(id: string): string {
      return store.getDisplayName(id) ?? `[${id}]`;
    }
    return { display };
  },
});

describe("useUserSummaries reactivity (Pinia store)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockFetch.mockReset();
  });

  it("updates display name after props.admins changes from empty to populated", async () => {
    mockFetch.mockResolvedValue({
      id1: {
        id: "id1",
        username: "alice",
        globalName: "Alice",
        avatarUrl: "",
        bot: false,
      },
      id2: {
        id: "id2",
        username: "bob",
        globalName: null,
        avatarUrl: "",
        bot: false,
      },
    });

    const wrapper = mount(RealisticComponent, {
      props: { admins: [] },
      global: { plugins: [createPinia()] },
    });
    expect(wrapper.findAll(".name").length).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();

    await wrapper.setProps({
      admins: [
        { userId: "id1", role: "admin" },
        { userId: "id2", role: "admin" },
      ],
    });

    expect(wrapper.findAll(".name").map((el) => el.text())).toEqual([
      "[id1]",
      "[id2]",
    ]);
    expect(mockFetch).toHaveBeenCalledWith(["id1", "id2"]);

    await flushPromises();
    await nextTick();

    expect(wrapper.findAll(".name").map((el) => el.text())).toEqual([
      "Alice",
      "bob",
    ]);
  });
});

describe("useUserSummaryStore cache poisoning", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockFetch.mockReset();
  });

  it("does NOT poison the cache on a transient failure — retries on the next resolve", async () => {
    const store = useUserSummaryStore();
    // A transient failure: fetchUserSummaries swallows it and returns {}.
    mockFetch.mockResolvedValueOnce({});
    await store.resolve(["id1"]);
    expect(store.getDisplayName("id1")).toBe(null); // raw-id fallback for now

    // Backend recovers. The id must be re-fetched (pre-fix it was poisoned to
    // null + TTL-stamped, so this second resolve was skipped for 5 minutes).
    mockFetch.mockResolvedValueOnce({
      id1: { id: "id1", username: "alice", globalName: "Alice", avatarUrl: "", bot: false },
    });
    await store.resolve(["id1"]);

    expect(mockFetch).toHaveBeenCalledTimes(2); // fails on main (2nd call was TTL-blocked)
    expect(store.getDisplayName("id1")).toBe("Alice");
  });

  it("negatively caches a genuinely-unknown id (returned as null) — no re-fetch within TTL", async () => {
    const store = useUserSummaryStore();
    mockFetch.mockResolvedValueOnce({ id9: null }); // backend answered: unknown user
    await store.resolve(["id9"]);
    expect(store.getDisplayName("id9")).toBe(null);

    await store.resolve(["id9"]); // within TTL → must NOT re-fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
