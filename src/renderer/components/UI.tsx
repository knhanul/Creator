import type {ButtonHTMLAttributes,ReactNode} from 'react';
import {ArrowRight,Check,FolderPlus, Sparkles} from 'lucide-react';
export function Button({children,kind='primary',size='md',...rest}:ButtonHTMLAttributes<HTMLButtonElement>&{kind?:'primary'|'secondary'|'ghost'|'outline'|'danger',size?:'sm'|'md'|'lg'}){
  return <button className={`btn btn-${kind} btn-${size}`} {...rest}>{children}</button>;
}
export function Tag({children,tone='muted'}:{children:ReactNode;tone?:'muted'|'accent'|'success'|'warning'}){return <span className={`tag tag-${tone}`}>{children}</span>;}
export function Card({children,className=''}:{children:ReactNode,className?:string}){return <div className={`panel ${className}`}>{children}</div>;}
export function Empty({title,description,action}:{title:string;description:string;action?:ReactNode}){return <div className="empty"><div className="empty-icon"><Sparkles size={25}/></div><h3>{title}</h3><p>{description}</p>{action}</div>;}
export function SectionHeading({eyebrow,title,description,action}:{eyebrow?:string,title:string,description?:string,action?:ReactNode}){return <header className="section-heading"><div>{eyebrow&&<div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2>{description&&<p>{description}</p>}</div>{action&&<div>{action}</div>}</header>;}
export function IconButton({label,children,onClick,disabled}:{label:string;children:ReactNode;onClick?:()=>void;disabled?:boolean}){return <button type="button" className="icon-btn" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;}
export function Field({label,description,children}:{label:string,description?:string,children:ReactNode}){return <label className="field"><span className="field-label">{label}</span>{children}{description&&<small>{description}</small>}</label>;}
export function Kpi({icon,value,label}:{icon:ReactNode,value:string|number,label:string}){return <div className="kpi"><div className="kpi-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span></div></div>;}
