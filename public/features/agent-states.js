// What each followed agent is doing, by terminal id (#12): the inbox stream writes it and the
// sidebar, tabs and panes read it when an agent has no card to say so.
//
// A module of its own because the two ends import each other: features/inbox.js already imports
// terminals.js, so terminals.js importing the map from it would close a cycle.

/** The last states the stream sent; empty until it answers. Replaced whole, never mutated. */
export const agentStates = { current: {} };

/** Keeps the states of the newest stream message (#12). */
export const setAgentStates = (states) => {
  agentStates.current = states && typeof states === 'object' ? states : {};
};
