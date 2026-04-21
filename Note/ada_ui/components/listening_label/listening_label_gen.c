/**
 * @file listening_label_gen.c
 * @brief Template source file for LVGL objects
 */

/*********************
 *      INCLUDES
 *********************/

#include "listening_label_gen.h"
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

lv_obj_t * listening_label_create(lv_obj_t * parent)
{
    LV_TRACE_OBJ_CREATE("begin");

    static lv_style_t listening_style;

    static bool style_inited = false;

    if (!style_inited) {
        lv_style_init(&listening_style);
        lv_style_set_width(&listening_style, 412);
        lv_style_set_bg_opa(&listening_style, 0);
        lv_style_set_border_width(&listening_style, 0);
        lv_style_set_text_color(&listening_style, ADA_BLUE);
        lv_style_set_text_align(&listening_style, LV_TEXT_ALIGN_CENTER);

        style_inited = true;
    }

    lv_obj_t * lv_label_0 = lv_label_create(parent);
    lv_obj_set_name_static(lv_label_0, "listening_label_#");

    lv_obj_add_style(lv_label_0, &listening_style, 0);

    LV_TRACE_OBJ_CREATE("finished");

    return lv_label_0;
}

/**********************
 *   STATIC FUNCTIONS
 **********************/

