ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "heros", force: :cascade do |t|
    t.string "name", null: false
  end

  create_table "order_items", force: :cascade do |t|
    t.string "sku", null: false
  end
end
