import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { change, control, tree, text } from "../modules/server-settings/forms.fixture.js";
import { IdentityFields } from "./identity-fields.js";
import { setupIdentity, present } from "./setup.fixture.js";
import { setupMessages } from "./messages.js";
const label = { es: "Opcional", en: "Optional", eu: "Aukerakoa" };
const provider = {
  ...setupIdentity,
  descriptor: {
    ...setupIdentity.descriptor,
    fields: [
      ...setupIdentity.descriptor.fields,
      {
        key: "endpoint",
        label,
        kind: "url" as const,
        required: false,
        defaultValue: "https://idp.test",
      },
      {
        key: "key",
        label: { es: "PEM", en: "PEM", eu: "PEM" },
        kind: "secret" as const,
        multiline: true,
        required: false,
      },
    ],
  },
};
it("shows nothing without installed plugins and offers only their declared localized fields", () => {
  const edit = vi.fn();
  const render = (values: Record<string, Record<string, string>>, providers = [provider]) => (
    <IdentityFields
      providers={providers}
      values={values}
      change={edit}
      locale="en"
      m={setupMessages("en")}
    />
  );
  expect(renderToStaticMarkup(render({}, []))).toBe("");
  const disabled = renderToStaticMarkup(render({}));
  expect(disabled).toContain(provider.descriptor.name.en);
  expect(disabled).not.toContain('type="password"');
  change(control(tree(render({})), provider.descriptor.name.en), { checked: true });
  expect(edit).toHaveBeenLastCalledWith({ [provider.id]: {} });
  const values = { [provider.id]: {}, "org.example.other": { preserved: "yes" } };
  const enabled = render(values);
  const html = renderToStaticMarkup(enabled);
  expect(tree(enabled).filter((node) => node.type === "input")).toHaveLength(5);
  expect(tree(enabled).filter((node) => node.type === "textarea")).toHaveLength(1);
  expect(html).toMatchSnapshot("enabled identity fields");
  expect(html).toContain('type="password"');
  expect(html).toContain('type="url"');
  expect(html).toContain('maxLength="16384"');
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain(setupMessages("en").advanced);
  change(control(tree(enabled), "domain"), { value: "school.test" });
  expect(edit).toHaveBeenLastCalledWith({ ...values, [provider.id]: { domain: "school.test" } });
  (
    present(tree(enabled).find((node) => node.type === "textarea")).props.onChange as (
      event: object,
    ) => void
  )({ currentTarget: { value: "line1\nline2" } });
  expect(edit).toHaveBeenLastCalledWith({ ...values, [provider.id]: { key: "line1\nline2" } });
  expect(control(tree(enabled), "Optional").value).toBe("https://idp.test");
  change(control(tree(render({ ...values, [provider.id]: { domain: "school.test" } })), "domain"), {
    value: "",
  });
  expect(edit).toHaveBeenLastCalledWith(values);
  change(control(tree(enabled), provider.descriptor.name.en), { checked: false });
  expect(edit.mock.lastCall?.[0]).toStrictEqual({ "org.example.other": { preserved: "yes" } });
  expect(renderToStaticMarkup(render({ [provider.id]: {} }, [setupIdentity]))).not.toContain(
    setupMessages("en").advanced,
  );
});

it("groups optional credentials with plugin help and can explicitly clear stored group secrets", () => {
  const m = setupMessages("en");
  const edit = vi.fn();
  const grouped = {
    ...provider,
    descriptor: {
      ...provider.descriptor,
      fields: [
        ...provider.descriptor.fields,
        { key: "note", label, kind: "text" as const, multiline: true, required: false },
      ],
      guides: [
        { id: "setup", title: label, steps: [{ text: label }] },
        {
          id: "group",
          title: { ...label, en: "Group setup" },
          steps: [{ text: label }],
          fields: ["key", "endpoint"],
        },
        { id: "notes", title: label, steps: [{ text: label }], fields: ["note"] },
      ],
    },
  };
  const values = { [provider.id]: { clientId: "keep", endpoint: "https://idp.test" } };
  const node = (
    <IdentityFields
      providers={[grouped]}
      values={values}
      secrets={{ [provider.id]: ["key", "clientSecret"] }}
      change={edit}
      locale="en"
      m={m}
    />
  );
  expect(renderToStaticMarkup(node)).toMatchSnapshot("grouped optional credentials");
  const nodes = tree(node);
  expect(text(nodes)).toContain("Group setup");
  expect(
    nodes.filter((n) => n.type === "details" && n.props.className === "identity-options"),
  ).toHaveLength(2);
  const clear = nodes.find((n) => n.type === "button" && text(n) === m.clearOptional);
  (present(clear).props.onClick as () => void)();
  expect(edit).toHaveBeenLastCalledWith({
    [provider.id]: { clientId: "keep", endpoint: "", key: "" },
  });
  const textarea = nodes.filter((n) => n.type === "textarea")[1];
  (present(textarea).props.onChange as (event: object) => void)({
    currentTarget: { value: "multiline public note" },
  });
  expect(edit).toHaveBeenLastCalledWith({
    [provider.id]: { ...values[provider.id], note: "multiline public note" },
  });
});
