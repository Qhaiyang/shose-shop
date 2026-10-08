import { redirect } from "next/navigation"

// 首页暂时直接进商品列表。
// 以后要做落地页的话，把这个文件替换成真正的首页即可。
export default function Home() {
  redirect("/products")
}
