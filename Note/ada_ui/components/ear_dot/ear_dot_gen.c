/**
 * @file ear_dot_gen.c
 * @brief Template source file for LVGL objects
 */

/*********************
 *      INCLUDES
 *********************/

#include "ear_dot_gen.h"
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

lv_obj_t * ear_dot_create(lv_obj_t * parent)
{
    LV_TRACE_OBJ_CREATE("begin");

    static lv_style_t ear_dot_s;

    static bool style_inited = false;

    if (!style_inited) {
        lv_style_init(&ear_dot_s);
        lv_style_set_width(&ear_dot_s, 14);
        lv_style_set_height(&ear_dot_s, 14);
        lv_style_set_radius(&ear_dot_s, 9999);
        lv_style_set_bg_color(&ear_dot_s, ADA_BLUE);
        lv_style_set_bg_opa(&ear_dot_s, 255);
        lv_style_set_border_width(&ear_dot_s, 0);

        style_inited = true;
    }

    lv_obj_t * lv_obj_0 = lv_obj_create(parent);
    lv_obj_set_name_static(lv_obj_0, "ear_dot_#");

    lv_obj_add_style(lv_obj_0, &ear_dot_s, 0);

    LV_TRACE_OBJ_CREATE("finished");

    return lv_obj_0;
}

/**********************
 *   STATIC FUNCTIONS
 **********************/

