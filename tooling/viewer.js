const { recordings, attributes } = JSON.parse(document.getElementById("recordings").textContent);
const select = document.getElementById("scenario");
const slider = document.getElementById("frame");
const play = document.getElementById("play");
const screen = document.getElementById("screen");
let timer;
let playing = false;

for (const [index, recording] of recordings.entries()) {
  const option = document.createElement("option");
  option.value = String(index);
  option.textContent = recording.title;
  select.append(option);
}

function rgba(color) {
  const [r, g, b, a] = color.rgba;
  return `rgba(${r},${g},${b},${a / 255})`;
}

function stop() {
  clearTimeout(timer);
  playing = false;
  play.textContent = "Play";
}

function draw() {
  const recording = recordings[Number(select.value)];
  const index = Number(slider.value);
  const frame = recording.frames[index];
  screen.replaceChildren();
  if (!frame) return;
  screen.style.width = `${frame.screen.cols}ch`;
  for (const line of frame.screen.lines) {
    for (const run of line) {
      const span = document.createElement("span");
      span.textContent = run.text;
      span.style.display = "inline-block";
      span.style.width = `${run.width}ch`;
      const inverse = run.attributes & attributes.INVERSE;
      span.style.color = rgba(inverse ? run.bg : run.fg);
      span.style.backgroundColor = rgba(inverse ? run.fg : run.bg);
      if (run.attributes & attributes.BOLD) span.style.fontWeight = "bold";
      if (run.attributes & attributes.DIM) span.style.opacity = "0.5";
      if (run.attributes & attributes.ITALIC) span.style.fontStyle = "italic";
      const decorations = [];
      if (run.attributes & attributes.UNDERLINE) decorations.push("underline");
      if (run.attributes & attributes.STRIKETHROUGH) decorations.push("line-through");
      span.style.textDecoration = decorations.join(" ");
      if (run.attributes & attributes.HIDDEN) span.style.visibility = "hidden";
      screen.append(span);
    }
    screen.append(document.createTextNode("\n"));
  }
  document.getElementById("position").textContent = `${index + 1} / ${recording.frames.length} · ${frame.at} ms`;
  document.getElementById("details").textContent = `${frame.screen.cols} × ${frame.screen.rows} cells${recording.droppedFrames ? ` · ${recording.droppedFrames} earlier frames discarded` : ""}. Terminal fonts and default palette may differ from your terminal.`;
}

function load() {
  stop();
  const recording = recordings[Number(select.value)];
  slider.max = String(Math.max(0, recording.frames.length - 1));
  slider.value = "0";
  document.getElementById("error").textContent = recording.error ?? "";
  const events = document.getElementById("events");
  events.replaceChildren();
  for (const event of recording.events) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `${event.at} ms · ${event.label}`;
    button.addEventListener("click", () => {
      stop();
      const next = recording.frames.findIndex(frame => frame.at >= event.at);
      slider.value = String(next < 0 ? recording.frames.length - 1 : next);
      draw();
    });
    item.append(button);
    events.append(item);
  }
  draw();
}

function advance() {
  const recording = recordings[Number(select.value)];
  const index = Number(slider.value);
  const next = recording.frames[index + 1];
  if (!next) { stop(); return; }
  timer = setTimeout(() => {
    slider.value = String(index + 1);
    draw();
    advance();
  }, Math.max(16, next.at - recording.frames[index].at));
}

select.addEventListener("change", load);
slider.addEventListener("input", () => { stop(); draw(); });
play.addEventListener("click", () => {
  if (playing) { stop(); return; }
  if (slider.value === slider.max) { slider.value = "0"; draw(); }
  playing = true;
  play.textContent = "Pause";
  advance();
});
load();
