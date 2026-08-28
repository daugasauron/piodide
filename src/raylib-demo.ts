export interface RaylibDemoClient {
  phone: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

/** Build the visible user request triggered by /demo. */
export function createRaylibDemoRequest(client: RaylibDemoClient): string {
  const device = client.phone ? "phone/touch device" : "desktop/laptop";
  const framebuffer = client.phone
    ? "360×640 (width 360, height 640)"
    : "640×360 (width 640, height 360)";
  const interaction = client.phone
    ? "Design for portrait play, use touch as the primary interaction, use large readable UI, and require no keyboard."
    : "Design for landscape, make rich use of mouse movement/clicks and a few clearly explained keyboard controls.";

  return `Create and launch an original, unusually polished raylib/Wasm showcase. The current client is a ${device} with a ${client.viewportWidth}×${client.viewportHeight} CSS-pixel viewport. ${interaction}

Try hard to make this feel like a finished interactive mini-experience, not a generic particle-field sample or a basic tutorial. Pick a strong visual concept and give it a clear name. Combine at least three cohesive visual systems—such as layered depth, reactive particles or trails, procedural motion, bursts, lighting-like glows, scene transitions, or animated typography—with satisfying interaction and a restrained purple, white, and green palette. Include a compact HUD that teaches the controls. Prioritize composition, motion, responsiveness, and delightful details while keeping all arrays and per-frame work bounded for a smooth frame rate. Surprise me.

Write the complete showcase yourself as valid C17 in /home/web/raylib-demo.c, then compile and open it. Before writing, mentally check the complete source for duplicate declarations, truncated functions, invalid string quoting, and unsupported APIs. Keep the implementation focused enough to finish reliably, but spend the available effort on polish rather than explanation.

Use this browser raylib contract exactly:
- Include raylib.h and define exactly void game_init(void) and void game_frame(float delta_seconds).
- Do not define main, create a frame loop, or call InitWindow, CloseWindow, or SetTargetFPS. The browser owns those. Put BeginDrawing() and EndDrawing() in game_frame.
- Raylib 6 2D drawing, text, textures, keyboard, mouse, and touch are supported. Audio and rmodels are unavailable.
- Use compile_raylib—not compile_c, link_wasi, run_wasi, Python, slop, HTML, or JavaScript—with path /home/web/raylib-demo.c, output /home/web/raylib-demo.wasm, and optimization "3".
- If compilation reports an error, inspect the diagnostic, edit the source, and retry until it succeeds.
- After a successful compile, call raylib exactly once with /home/web/raylib-demo.wasm, framebuffer ${framebuffer}, and your showcase name as the title.

This is an execution task. Use the tools now and do not stop at a code listing or explanation; finish with the running showcase.`;
}
