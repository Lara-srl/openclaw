/**
 * @file boot_status_gen.c
 * @brief Template source file for LVGL objects
 */

/*********************
 *      INCLUDES
 *********************/

#include "boot_status_gen.h"
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

lv_obj_t * boot_status_create(lv_obj_t * parent)
{
    LV_TRACE_OBJ_CREATE("begin");

    static lv_style_t status_style;

    static bool style_inited = false;

    if (!style_inited) {
        lv_style_init(&status_style);
        lv_style_set_width(&status_style, 300);
        lv_style_set_bg_opa(&status_style, 0);
        lv_style_set_border_width(&status_style, 0);
        lv_style_set_text_color(&status_style, lv_color_hex(0x888888));
        lv_style_set_text_align(&status_style, LV_TEXT_ALIGN_CENTER);

        style_inited = true;
    }

    lv_obj_t * lv_label_0 = lv_label_create(parent);
    lv_obj_set_name_static(lv_label_0, "boot_status_#");

    lv_obj_add_style(lv_label_0, &status_style, 0);

    LV_TRACE_OBJ_CREATE("finished");

    return lv_label_0;
}

/**********************
 *   STATIC FUNCTIONS
 **********************/

