// The Rust module/field spelling is not the physical SQL identifier.
diesel::table! {
    #[sql_name = "WidgetParts"]
    widget_parts (part_id) {
        part_id -> BigInt,
        #[sql_name = "partNumber"]
        part_number -> Text,
    }
}
