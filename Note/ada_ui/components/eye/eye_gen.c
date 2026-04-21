/**
 * @file eye_gen.c
 * @brief Template source file for LVGL objects
 */

/*********************
 *      INCLUDES
 *********************/

#include "eye_gen.h"
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

lv_obj_t * eye_create(lv_obj_t * parent)
{
    LV_TRACE_OBJ_CREATE("begin");

    static lv_style_t pill;

    static bool style_inited = false;

    if (!style_inited) {
        lv_style_init(&pill);
        lv_style_set_width(&pill, ADA_EW);
        lv_style_set_height(&pill, ADA_EH);
        lv_style_set_radius(&pill, ADA_ER);
        lv_style_set_bg_color(&pill, ADA_BLUE);
        lv_style_set_bg_opa(&pill, 255);
        lv_style_set_border_width(&pill, 0);

        style_inited = true;
    }

    lv_obj_t * lv_obj_0 = lv_obj_create(parent);
    lv_obj_set_name_static(lv_obj_0, "eye_#");

    lv_obj_add_style(lv_obj_0, &pill, 0);

    LV_TRACE_OBJ_CREATE("finished");

    return lv_obj_0;
}

/**********************
 *   STATIC FUNCTIONS
 **********************/

