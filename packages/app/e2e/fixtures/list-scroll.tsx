import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { List } from "@opencode-ai/ui/list"
import "@opencode-ai/ui/styles"

const params = new URLSearchParams(location.search)

render(() => {
  const [header, setHeader] = createSignal(params.has("header"))
  const [selected, setSelected] = createSignal("")
  return (
    <>
      <button onClick={() => setHeader(!header())}>Toggle header</button>
      <output>{selected()}</output>
      <List
        items={params.has("empty") ? [] : Array.from({ length: 30 }, (_, i) => `Model ${i}`)}
        key={(item) => item}
        search={{ placeholder: "Search models" }}
        emptyMessage="No models"
        scrollHeader={<Show when={header()}><button data-testid="header" onClick={() => setSelected("Chain")}>Chain</button></Show>}
        onSelect={(item) => setSelected(item ?? "")}
      >
        {(item) => <span>{item}</span>}
      </List>
    </>
  )
}, document.getElementById("root")!)
