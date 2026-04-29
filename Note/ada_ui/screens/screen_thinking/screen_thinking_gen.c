/**
 * @file screen_thinking_gen.c
 * @brief Template source file for LVGL objects
 */

/*********************
 *      INCLUDES
 *********************/

#include "screen_thinking_gen.h"
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

lv_obj_t * screen_thinking_create(void)
{
    LV_TRACE_OBJ_CREATE("begin");

    static lv_style_t ring_s;

    static bool style_inited = false;

    if (!style_inited) {
        lv_style_init(&ring_s);
        lv_style_set_radius(&ring_s, 9999);
        lv_style_set_bg_opa(&ring_s, 0);
        lv_style_set_border_width(&ring_s, 10);
        lv_style_set_border_color(&ring_s, ADA_BLUE);
        lv_style_set_border_opa(&ring_s, 255);

        style_inited = true;
    }

    lv_obj_t * lv_obj_0 = lv_obj_create(NULL);
    lv_obj_set_name_static(lv_obj_0, "screen_thinking_#");

    lv_obj_add_style(lv_obj_0, &ring_s, 0);

    LV_TRACE_OBJ_CREATE("finished");

    return lv_obj_0;
}

/**********************
 *   STATIC FUNCTIONS
 **********************/

