/**
 * @file thinking_ring_gen.c
 * @brief Template source file for LVGL objects
 */

/*********************
 *      INCLUDES
 *********************/

#include "thinking_ring_gen.h"
#include "../../ada_ui.h"

/*********************
 *      DEFINES
 *********************/

/**********************
 *      TYPEDEFS
 **********************/

/***********************
 *  STATIC VARIABLES
 **********************/

/***********************
 *  STATIC PROTOTYPES
 **********************/

/**********************
 *   GLOBAL FUNCTIONS
 **********************/

lv_obj_t * thinking_ring_create(lv_obj_t * parent)
{
    LV_TRACE_OBJ_CREATE("begin");

    static lv_style_t ring_s;

    static bool style_inited = false;

    if (!style_inited) {
        lv_style_init(&ring_s);
        lv_style_set_bg_opa(&ring_s, 0);
        lv_style_set_border_width(&ring_s, 0);
        lv_style_set_pad_top(&ring_s, 0);
        lv_style_set_pad_bottom(&ring_s, 0);
        lv_style_set_pad_left(&ring_s, 0);
        lv_style_set_pad_right(&ring_s, 0);

        style_inited = true;
    }

    lv_obj_t * lv_arc_0 = lv_arc_create(parent);
    lv_obj_set_name_static(lv_arc_0, "thinking_ring_#");

    lv_obj_add_style(lv_arc_0, &ring_s, 0);

    LV_TRACE_OBJ_CREATE("finished");

    return lv_arc_0;
}

/**********************
 *   STATIC FUNCTIONS
 **********************/

