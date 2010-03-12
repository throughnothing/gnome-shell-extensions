/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
const Main = imports.ui.main;
function noAnimate(actor) { return false; }
function main() {
	Main.wm._shouldAnimate = noAnimate;
}
