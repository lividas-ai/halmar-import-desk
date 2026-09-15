import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({
      to: "/work",
      search: { category: "all", page: 1, q: "" },
    });
  },
});
