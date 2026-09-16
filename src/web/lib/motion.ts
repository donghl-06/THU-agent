import type {Variants} from "motion/react";

/** Shared entrance rhythm for the welcome and scheduled-task workspaces. */
export const staggeredReveal: Variants = {
    hidden: {},
    visible: {transition: {staggerChildren: .065}},
};

export const contentReveal: Variants = {
    hidden: {opacity: 0, y: 12},
    visible: {opacity: 1, y: 0, transition: {duration: .5}},
};
