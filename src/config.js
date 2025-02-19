"use strict";
/*
 * Compile time configuration, some only relevant for debug mode
 */

/**
 * @define {boolean}
 * Overridden for production by closure compiler
 */
var DEBUG = true;

/**
 * @define {boolean}
 */
var LOG_TO_FILE = false;

/**
 * @define {boolean}
 * Enables logging all IO port reads and writes. Very verbose
 */
var LOG_ALL_IO = false;

/**
 * @define {boolean}
 */
var DUMP_GENERATED_WASM = false;

/**
 * @define {boolean}
 */
var DUMP_UNCOMPILED_ASSEMBLY = false;

/**
 * @define {boolean}
 * More accurate filenames in 9p debug messages at the cost of performance.
 */
var TRACK_FILENAMES = false;

/**
 * @define {number}
 */
var LOG_LEVEL = LOG_ALL & ~LOG_PS2 & ~LOG_PIT & ~LOG_VIRTIO & ~LOG_9P & ~LOG_PIC &
                          ~LOG_DMA & ~LOG_SERIAL & ~LOG_NET & ~LOG_FLOPPY & ~LOG_DISK & ~LOG_VGA & ~LOG_SB16;

/**
 * @define {boolean}
 * Draws entire buffer and visualizes the layers that would be drawn
 */
var DEBUG_SCREEN_LAYERS = DEBUG && false;

/**
 * @define {number}
 * How many ticks the TSC does per millisecond
 */
var TSC_RATE = 1 * 1000 * 1000;

/**
 * @define {number}
 */
var APIC_TIMER_FREQ = TSC_RATE;
