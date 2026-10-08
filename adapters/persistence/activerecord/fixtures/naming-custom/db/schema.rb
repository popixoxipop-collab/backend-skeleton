ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "acme_heroes", force: :cascade do |t|
    t.string "name", null: false
  end
end
